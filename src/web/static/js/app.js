/* app.js — global state, project loading, session loading */

// `allSessions` and `allSessionIds` are owned by SessionStore
// (src/web/static/js/session-store.js, loaded before this file).  Both names are
// window accessors onto the store: reading `allSessions` returns the store's
// array, assigning it calls SessionStore.replaceAll(), and `allSessionIds` is
// the store's id Set.  Do NOT declare them here again: a top-level `let` of
// the same name throws at load.
//
// PERF-CRITICAL: O(1) Set lookup. Do NOT replace .has() with .find(). See CLAUDE.md #15.
// The session_entry handler checks membership on EVERY streaming token to
// filter cross-project events; a linear allSessions.find() there costs
// 5,000 scans per response with 50 sessions and 100 entries per turn.  SessionStore.has() / the
// allSessionIds Set is the O(1) answer, and the store keeps it in step with
// the list at every mutation, so call sites no longer maintain it by hand.
/**
 * Kept for callers that predate the store.  The store re-derives its index on
 * every bulk change, so this only repairs drift from a legacy raw array
 * mutation, then prunes the sidebar multi-selection.
 */
function _rebuildSessionIds() {
  SessionStore.reindexIfDrifted();
  // Sidebar multi-selection may hold IDs that were filtered out by this
  // bulk reassignment (e.g. deleteEmptySessions, loadSessions purge,
  // session-type filter).  Prune so the badge count and DOM don't lie.
  // Guarded by typeof so this stays callable before sessions.js loads.
  if (typeof _pruneMultiSelectionToExisting === 'function') {
    _pruneMultiSelectionToExisting();
  }
}

// ── Session title memory ─────────────────────────────────────────────────
// A session's name reaches the client as a ONE-SHOT event: the auto-name
// HTTP reply, or the `session_renamed` broadcast.  Both patch the row that
// exists at that moment and nothing else, so any row created or rebuilt
// AFTER the event came up with a placeholder and kept it until a manual
// refresh re-read the names from disk.  Two ways that happened:
//   • A tab or device that did not start the session gets the broadcast
//     BEFORE it has the row.  The row arrives later as a state_snapshot stub,
//     titled from the daemon's `name`, which is empty for GUI sessions:
//     "New Session".
//   • A session-list reload computed before the title was saved lands after
//     it, and replaces the titled row with the server's placeholder.
// Every title the client learns is remembered here for the life of the page
// and filled into rows that have NO name of their own.  A name the server
// returns is never overridden.  Applied wherever rows are created or rebuilt:
// loadSessions(), the state_snapshot / session_started stubs and the
// session_id_remapped handler (socket.js).  Tests:
// tests/test_session_title_memory.py.
const _knownSessionTitles = SessionStore.titles;   // session_id -> title (owned by the store)
const _KNOWN_SESSION_TITLES_MAX = 500;

/** Remember a confirmed session title (rename / auto-name). */
function _rememberSessionTitle(id, title) {
  if (!id || !title) return;
  _knownSessionTitles.delete(id);          // re-insert: newest last
  _knownSessionTitles.set(id, title);
  if (_knownSessionTitles.size > _KNOWN_SESSION_TITLES_MAX) {
    _knownSessionTitles.delete(_knownSessionTitles.keys().next().value);
  }
}

/** Carry a remembered title across an SDK session-id remap. */
function _remapSessionTitle(oldId, newId) {
  const t = _knownSessionTitles.get(oldId);
  if (t && newId && !_knownSessionTitles.has(newId)) _rememberSessionTitle(newId, t);
}

/** The remembered title for a session, or ''. */
function _knownSessionTitle(id) {
  return (id && _knownSessionTitles.get(id)) || '';
}

/** Fill a nameless row from memory.  Returns true when the row changed. */
function _applyKnownSessionTitle(s) {
  if (!s || s.custom_title) return false;
  const t = _knownSessionTitle(s.id);
  if (!t) return false;
  s.custom_title = t;
  s.display_title = t;
  return true;
}

let activeId = localStorage.getItem('activeSessionId') || null;
let renameTarget = null;
let sortMode = localStorage.getItem('sortMode') || 'date';
let sortAsc  = localStorage.getItem('sortAsc') === 'true';
// VibeNode always opens on Sessions (there is no view switcher in the
// sidebar any more; the other views are under the ••• menu).
let viewMode = 'sessions';
// Hash-based routing: URL hash overrides stored viewMode for direct-link support
if (window.location.hash.startsWith('#kanban')) viewMode = 'kanban';
if (window.location.hash.startsWith('#compose')) viewMode = 'compose';
// A fresh tab opened on /#kanban or /#compose while the STORED mode was
// 'homepage': the boot script in index.html hid the sidebar
// for the homepage before this file ran, and loadSessions() then calls
// setViewMode(viewMode) with prevMode === viewMode, so the "leaving homepage:
// restore sidebar" branch in workforce.js never runs, leaving the board with
// no sidebar and no project switcher.  Undo the boot hide here, where the hash
// override happens.  Tests: tests/test_visible_fixes.py.
(function _restoreSidebarAfterHashRoute() {
  if (viewMode === 'homepage') return;
  const sb = document.querySelector('.sidebar');
  if (!sb || sb.style.display !== 'none') return;   // only the boot script's inline hide
  sb.style.display = '';
  const rh = document.querySelector('.resize-handle');
  if (rh) rh.style.display = '';
  const eb = document.getElementById('btn-sidebar-expand');
  if (eb) {
    eb.style.display = '';
    eb.classList.toggle('visible', sb.classList.contains('collapsed'));
  }
})();
// Session display sub-mode (grid vs list vs control within sessions view)
let sessionDisplayMode = localStorage.getItem('sessionDisplayMode') || 'grid';
if (!['grid', 'list', 'control'].includes(sessionDisplayMode)) sessionDisplayMode = 'grid';
// One sort choice for the session panel, shared by cards and list, and
// remembered per device (localStorage sortMode + sortAsc; wfSort mirrors it for
// the card grid).  Choices are the ones in the options menu:
//   status  "Active first": question, working, idle, sleeping; newest first within each
//   date    Newest / Oldest first        name  A-Z / Z-A        size  Largest / Smallest
// 'status' is a visible, selectable option, so a stored 'status' is a real
// choice and is honoured.
let wfSort = localStorage.getItem('wfSort') || 'recent';
// runningIds (Set), waitingData ({id: {question, options, kind}}), sessionKinds
// ({id: 'question'|'working'|'idle'}) and guiOpenSessions (Set, seeded from
// localStorage) are per-session tables owned by SessionStore and exposed as
// window accessors (session-store.js).  Assigning one replaces the table.
let liveSessionId = null;
let _activeGrpPopup = null;
let respondTarget = null;
let _allProjects = [];  // cached project list for overlay
let _apChooseOpen = false;  // the picker's Choose list under All projects is open

/** The projects All projects covers changed (the picker's Choose list): when
 *  that view is open, redraw the sidebar from the new set.  Debounced, so
 *  ticking several boxes in a row loads once. */
let _apSubsetTimer = null;
function _apSubsetChanged() {
  clearTimeout(_apSubsetTimer);
  _apSubsetTimer = setTimeout(() => {
    if (!(window.VNAllProjects && VNAllProjects.on())) return;
    _updateProjectLabel(null);
    if (typeof loadSessions === 'function') loadSessions();
    if (typeof socket !== 'undefined' && socket.connected) socket.emit('request_state_snapshot', { project: localStorage.getItem('activeProject') || '' });
  }, 350);
}

// Workspace / Workplace state (used by workspace.js)
let workspaceActive = false;
let _wsExpandedId = null;
let permissionQueue = [];
let permissionPolicy = localStorage.getItem('permPolicy') || 'manual';
let customPolicies = JSON.parse(localStorage.getItem('customPolicies') || '{}');
let workspaceHiddenSessions = new Set(JSON.parse(localStorage.getItem('wsHiddenSessions') || '[]'));
let workspaceCardPositions = JSON.parse(localStorage.getItem('wsCardPositions') || '{}');
let _answerPending = {};
let _lastAnswer = {};
let _resendCount = {};
let _lastSendTimePerSession = {};
let _waitingPolledOnce = true;  // WebSocket push means we always have state

// Browser URL navigation for chats (mirrors folder navigation pattern)
let _skipChatHistory = false;
let _suppressSessionRestore = false;  // set during project switch to prevent loadSessions from auto-opening a saved session
function _pushChatUrl(chatId) {
  if (_skipChatHistory) return;
  // Don't push chat URLs in kanban mode — kanban manages its own history
  if (typeof viewMode !== 'undefined' && viewMode === 'kanban') return;
  const url = new URL(window.location);
  url.searchParams.delete('panel');   // a popup belongs to the view it was opened on (last-card.js)
  if (chatId) url.searchParams.set('chat', chatId);
  else url.searchParams.delete('chat');
  history.pushState({
    folder: (typeof _currentFolderId !== 'undefined' ? _currentFolderId : null),
    chat: chatId || null
  }, '', url);
}

// Tell the server which project is active. NEVER throws.
//
// Both call sites sit between showSkeletonLoader() and loadSessions(). An
// unguarded `await fetch` here means a single transient failure -- the server
// mid-restart, a dropped Tailscale connection, a phone waking up -- aborts the
// whole chain: loadSessions() never runs, so the skeleton shimmers forever with
// no error and no way out but a manual reload. That is exactly the failure
// loadProjects() below was hardened against, and it was still live one level
// down.
//
// Failing is survivable, so we continue rather than give up: loadSessions()
// passes ?project= explicitly and does not depend on this call having landed.
// Resolving the skeleton to a real (possibly stale) list always beats leaving
// the user staring at placeholders.
async function _syncActiveProject(encoded, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch('/api/set-project', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({project: encoded})
      });
      if (r.ok) return true;
    } catch (e) { /* server mid-boot / connection reset -- retry below */ }
    await new Promise(r => setTimeout(r, 400));
  }
  console.warn('[setProject] server never accepted active project', encoded,
               '- continuing so the skeleton still resolves');
  return false;
}

async function loadProjects() {
  // Resilient fetch of the project list. This is the boot entry point, and it
  // can run against a backend that is still coming up — most importantly when
  // the mobile reviver navigates here the instant Flask serves index.html, a
  // moment BEFORE /api/projects (and the daemon behind it) is ready. If that
  // first fetch throws or returns a non-OK/non-JSON body, the whole init chain
  // used to die uncaught and the skeleton loader hung forever (the "infinite
  // skeleton until I exit and come back" bug — a fresh reload later hit a ready
  // backend and worked). Retry with backoff until the backend actually answers,
  // so the boot always completes instead of dying on a transient early failure.
  let res, ok = false;
  for (let attempt = 0; attempt < 40; attempt++) {   // ~40 * 750ms ≈ 30s ceiling
    try {
      res = await fetch('/api/projects', { cache: 'no-store' });
      if (res.ok) {
        _allProjects = await res.json();
        ok = true;
        break;
      }
    } catch (e) { /* server mid-boot / connection reset — retry below */ }
    await new Promise(r => setTimeout(r, 750));
  }
  if (!ok) {
    // Backend never came up in the retry window. Leave a clear, non-skeleton
    // state and let the server-reachable health check take over recovery.
    const listEl = document.getElementById('session-list');
    if (listEl) listEl.innerHTML = '<div class="empty-state" style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Reconnecting to DevelopNode…</div>';
    return;
  }
  const saved = localStorage.getItem('activeProject');
  // The picker's status columns are ready before it is first opened.
  setTimeout(_refreshProjectStatus, 1500);

  // Update the button label
  const savedMatch = _allProjects.find(p => p.encoded === saved);
  _updateProjectLabel(savedMatch || _allProjects[0]);

  // If saved project has sessions use it; otherwise pick the project with the most sessions
  const target = (savedMatch && savedMatch.session_count > 0)
    ? saved
    : (_allProjects.slice().sort((a,b) => b.session_count - a.session_count)[0] || {}).encoded;
  if (target) {
    // If the saved project is the same as the target, skip the full
    // setProject teardown (which destroys live panels and clears state).
    // Just sync the server and load sessions without the nuclear reset.
    if (saved && saved === target) {
      localStorage.setItem('activeProject', target);
      await _syncActiveProject(target);
      await loadSessions();
    } else {
      await setProject(target, true);
    }
  } else {
    // No project available — clear skeleton and show prompt
    const listEl = document.getElementById('session-list');
    if (listEl) listEl.innerHTML = '<div class="empty-state" style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">No projects found.<br>Click the project selector above to get started.</div>';
    document.getElementById('main-body').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:14px;flex-direction:column;gap:8px;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>Select a project to begin</span></div>';
  }
}

function _projectShortName(project) {
  if (project.custom_name) return project.custom_name;
  const parts = project.display.replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

function _updateProjectLabel(project) {
  const label = document.getElementById('project-label');
  // The project row's icon is the project's initial in a small outline tile
  // (drawn in CSS from this attribute).  No project selected -> the folder icon.
  const btn = document.getElementById('btn-project');
  if (window.VNAllProjects && VNAllProjects.on()) {
    if (btn) btn.dataset.initial = '\u2217';
    label.innerHTML = escHtml(VNAllProjects.label ? VNAllProjects.label() : 'All projects') + ' <span class="sidebar-mini-label">project</span>'; return;
  }
  if (!project) {
    if (btn) delete btn.dataset.initial;
    label.innerHTML = 'Select project <span class="sidebar-mini-label">project</span>'; return;
  }
  const name = document.createElement('span');
  name.textContent = _projectShortName(project);
  if (btn) btn.dataset.initial = (name.textContent.trim().charAt(0) || '?').toUpperCase();
  // A "phoned you" project (Phone a Friend) shows a phone instead of its initial.
  if (btn) { if (project.phoned) btn.dataset.phoned = '1'; else delete btn.dataset.phoned; }
  label.innerHTML = name.innerHTML + ' <span class="sidebar-mini-label">project</span>';
}

// Generation counter: bumped on every project switch. Async callbacks
// (WebSocket handlers, fetch responses) check this to discard stale data
// that arrived after the user already switched projects.
let _projectSwitchGen = 0;

// The session-list load the latest setProject() started.  setProject does not
// wait for it (boot and other callers rely on that); the project-switch splash does.
let _projectSwitchLoad = null;

async function setProject(encoded, reload = true) {
  ++_projectSwitchGen;  // invalidate all in-flight async for old project
  // Save the current view mode and active session for the OLD project so we
  // can restore them when the user switches back later.
  const prevProject = localStorage.getItem('activeProject');
  if (prevProject) {
    if (activeId) localStorage.setItem('projectSession_' + prevProject, activeId);
    if (viewMode) localStorage.setItem('projectView_' + prevProject, viewMode);
    // Save per-view navigation position (drill-down, active session, etc.)
    if (typeof _saveViewPosition === 'function') _saveViewPosition(prevProject, viewMode);
  }
  // Tear down any active session/live-panel from the old project.
  // Use _skipChatHistory so deselectSession() doesn't push a history entry,
  // but then explicitly scrub the ?chat param so loadSessions() doesn't try
  // to restore a session ID that belongs to the old project.
  _skipChatHistory = true;
  if (activeId) {
    deselectSession();
  } else if (liveSessionId) {
    // Live panel open without activeId (e.g. brand-new session) — tear it down
    stopLivePanel();
  }
  _skipChatHistory = false;
  // Always clear stale session state from URL + localStorage
  activeId = null;
  liveSessionId = null;
  localStorage.removeItem('activeSessionId');
  const _cleanUrl = new URL(window.location);
  if (_cleanUrl.searchParams.has('chat')) {
    _cleanUrl.searchParams.delete('chat');
    history.replaceState({ folder: null, chat: null }, '', _cleanUrl);
  }
  setToolbarSession(null, 'No session selected', true, '');

  const p = _allProjects.find(x => x.encoded === encoded);
  _updateProjectLabel(p);
  localStorage.setItem('activeProject', encoded);
  // Clear cross-project session cache — sessions from the OLD project were
  // cached as "other project" and must be re-evaluated against the new project.
  // Sessions from the NEW project that were previously hidden will pass through
  // _isOtherProject on their next event. Sessions from the old project will be
  // re-detected and re-cached on their next event.
  if (typeof _clearCrossProjectCache === 'function') _clearCrossProjectCache();
  // Clear session state from the old project so cross-project sessions
  // don't bleed into the sidebar. The upcoming state_snapshot will
  // repopulate with current-project sessions only.
  sessionKinds = {};
  runningIds = new Set();
  waitingData = {};
  // Clear allSessions so old-project sessions don't remain visible in the
  // sidebar/grid during the gap between project switch and loadSessions().
  SessionStore.replaceAll([]);
  // Reset main body to the dashboard so the old chat isn't visible while the
  // new project loads.  Built here, AFTER activeProject and the session data
  // are switched: built earlier it showed the OLD project's name and counts.
  const _mb = document.getElementById('main-body');
  if (_mb) _mb.innerHTML = _buildDashboard();
  // Clear sidebar multi-selection — the IDs in it belong to the old
  // project and are about to vanish from allSessionIds.  Calling
  // _clearMultiSelect() is also safe when sessions.js hasn't loaded yet
  // (typeof guard) but in practice it's always loaded by this point.
  if (typeof _clearMultiSelect === 'function') _clearMultiSelect();
  // Clear per-session state maps that would otherwise carry stale data from
  // the old project into the new one (timestamps, substatus, usage, timers).
  window._sessionStateTs = {};
  window._workingSinceMap = {};
  if (window._sessionSubstatus) window._sessionSubstatus = {};
  if (window._sessionUsage) window._sessionUsage = {};
  window._subAgents = {};
  // --- Clear view-specific state from the old project ---
  // Folder tree: stale folder IDs / cached tree from old project
  if (typeof _currentFolderId !== 'undefined') _currentFolderId = null;
  if (typeof _folderTreeCache !== 'undefined') _folderTreeCache = null;
  // Workspace: hidden sessions and card positions are per-project
  workspaceHiddenSessions = new Set();
  localStorage.removeItem('wsHiddenSessions');
  workspaceCardPositions = {};
  localStorage.removeItem('wsCardPositions');
  _wsExpandedId = null;
  const _wsBackBtn = document.getElementById('ws-back-btn');
  if (_wsBackBtn) _wsBackBtn.remove();
  // Kanban: reset board state if we're currently in kanban view
  if (viewMode === 'kanban' && typeof resetKanbanState === 'function') {
    resetKanbanState();
    const _kSessionBar = document.getElementById('kanban-session-bar');
    if (_kSessionBar) _kSessionBar.remove();
    // Scrub the drill-down hash so restoreFromHash() doesn't re-open old task
    const _kUrl = new URL(window.location);
    if (_kUrl.hash.startsWith('#kanban/task/')) {
      _kUrl.hash = '#kanban';
      history.replaceState({ view: 'kanban', taskId: null }, '', _kUrl.pathname + _kUrl.search + '#kanban');
    }
  }
  // Compose: reset board state if we're currently in compose view
  if (viewMode === 'compose') {
    if (typeof resetComposeState === 'function') resetComposeState();
    // DOM-CRITICAL: Only clear the dynamic card area, NOT the parent
    // compose-board.  The parent holds static children from index.html
    // (compose-root-header, compose-input-target, compose-sections-board)
    // that initCompose() looks up by ID.  Setting compose-board.innerHTML=''
    // destroys them and initCompose() silently writes to null → blank panel.
    // See CLAUDE.md "Compose project-scoping" item 4.
    const _composeSectionsBoard = document.getElementById('compose-sections-board');
    if (_composeSectionsBoard) { _composeSectionsBoard.innerHTML = ''; }
    // Scrub any compose sub-route hash back to base
    const _cUrl = new URL(window.location);
    if (_cUrl.hash.startsWith('#compose/')) {
      _cUrl.hash = '#compose';
      history.replaceState({ view: 'compose' }, '', _cUrl.pathname + _cUrl.search + '#compose');
    }
  }
  // Kanban: clear persisted filters / expanded tasks / history that belong to old project
  kanbanExpandedTasks = new Set();
  localStorage.removeItem('kanbanExpanded');
  kanbanActiveTagFilter = [];
  sessionStorage.removeItem('kanbanTagFilter');
  if (typeof _kanbanHistory !== 'undefined') { _kanbanHistory = []; localStorage.removeItem('kanbanRecentHistory'); }
  // Show skeleton immediately
  if (reload) showSkeletonLoader();
  await _syncActiveProject(encoded);
  // Reset agent catalog so it gets re-written for the new project
  _agentCatalogPath = null;
  _agentCatalogPromise = null;
  // Update SocketIO query params so reconnects use the new project
  if (typeof socket !== 'undefined') {
    if (socket.io && socket.io.opts) socket.io.opts.query = { project: encoded };
    // Re-sync live session states from daemon (working_since, sessionKinds, etc.)
    if (socket.connected) socket.emit('request_state_snapshot', {project: encoded});
  }
  if (reload) {
    // Restore the last-open session only if the target view is sessions;
    // in every other view, suppress restore so the view resets to base state.
    // Use the saved per-project view (if any) to decide, since viewMode
    // hasn't been updated to the target yet at this point.
    _suppressSessionRestore = false;  // a project switch always lands on Sessions
    _projectSwitchLoad = loadSessions();
  }
}

// --- Project Overlay ---
function openProjectOverlay() {
  const overlay = document.getElementById('project-overlay');
  const card = document.getElementById('project-card');

  // The Choose list under All projects stays as it was left (per device), so
  // the projects picked there are in view whenever the picker opens again.
  try { _apChooseOpen = localStorage.getItem('vnApChooseOpen') === '1'; } catch (e) { _apChooseOpen = false; }
  // The Add flow pads the list differently; put it back.
  const list = document.getElementById('project-list');
  if (list) list.style.padding = '';
  // Every open starts out of Edit order.
  _projEditing = false;

  // Show the overlay immediately so the tap feels responsive, then render.
  overlay.classList.add('show');
  card.classList.add('pm-enter');
  requestAnimationFrame(() => card.classList.remove('pm-enter'));
  // Close on backdrop click
  overlay.onclick = e => { if (e.target === overlay) closeProjectOverlay(); };

  _renderProjectOverlay();

  // Self-heal for the empty-list failure mode. The startup loadProjects() call
  // (socket.js) populates _allProjects from /api/projects. If that fetch was
  // slow (mobile over Tailscale, cold Wi-Fi), dropped, or hit a transient
  // error, _allProjects stays [] and the overlay renders zero rows — user sees
  // just the header and "+ Add Project" with no way to reach their projects
  // short of a full page refresh. Refetching here recovers automatically the
  // next time they tap "Select project" instead of leaving them stuck.
  // Refetch on EVERY open, not only when empty: the list cached at page load
  // goes stale when projects are removed on disk.
  // The cached rows render first, so the tap still feels instant.
  _refreshProjectsAndRerender();
}

/** Display form of a project path: the home directory becomes "~" (the full
 *  path is still the row's tooltip).  Shorter, and it keeps a username out of
 *  the picker when the screen is shared. */
function _projectShortPath(p) {
  return String(p || '')
    .replace(/^\/(?:home|Users)\/[^\/]+/, '~')
    .replace(/^[A-Za-z]:[\\\/]Users[\\\/][^\\\/]+/, '~');
}

// A project of sessions friends phoned you about (Phone a Friend) is marked
// with a phone instead of its first letter.
const _PHONED_PROJECT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>';

/** A steady colour for a project's letter tile, from its name, so the same
 *  project is the same colour on every device and every open. */
function _projectHue(name) {
  let h = 2166136261;  // FNV-1a: spreads similar names ("…Node") apart
  for (const c of String(name || '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % 360;
}

// The picker's status columns (Smart termination on): Needs you, Standby,
// Working, in the sidebar's own icons and colours (session-verb.js).
const _PS_GROUPS = ['needs', 'standby', 'working'];
const _PS_LABEL = { needs: 'Needs you', standby: 'Standby', working: 'Working' };
function _psIcon(g) {
  if (g === 'working') return '<img class="ps-pick" src="/static/svg/pickaxe.svg" width="12" height="12" alt="">';
  return (window.SessionVerbCore && SessionVerbCore.iconHtml) ? SessionVerbCore.iconHtml(g, 13) : '';
}
let _projectStatusReq = 0;
// The last counts this device saw, so the picker opens on its columns at once
// (drawing the totals until the fetch landed flashed the old picker).
const _PS_SAVED = 'vnProjectStatus';
try { window._projectStatusCounts = JSON.parse(localStorage.getItem(_PS_SAVED) || 'null') || undefined; } catch (_e) { /* unreadable: fetched below */ }
/** The open project's counts, from the statuses the sidebar draws right now
 *  (session-verb.js), so they never lag the sidebar.  In All projects every
 *  project in the list is counted.  {} when the list is not loaded. */
function _localProjectCounts() {
  const core = window.SessionVerbCore;
  if (!core || typeof SessionStore === 'undefined' || !SessionStore.all) return {};
  const rows = SessionStore.all() || [];
  if (!rows.length) return {};
  const allMode = !!(window.VNAllProjects && VNAllProjects.on() && VNAllProjects.projectOf);
  const here = localStorage.getItem('activeProject') || '';
  const out = {};
  for (const r of rows) {
    if (!r || !r.id) continue;
    const proj = allMode ? VNAllProjects.projectOf(r.id) : here;
    if (!proj) continue;
    const c = out[proj] || (out[proj] = { needs: 0, standby: 0, working: 0 });
    const g = core.shown(core.display(r.id));
    if (g in c) c[g]++;
  }
  return out;
}

/** Redraw the picker if it is open (from the counts already known). */
function _redrawOpenPicker() {
  const overlay = document.getElementById('project-overlay');
  if (overlay && overlay.classList.contains('show')) _renderProjectOverlay(true);
}

// Keep every project's counts current while the page is open, so opening the
// picker shows them at once: any status change anywhere (debounced), and every
// 20 s while the tab is in view.  The open project follows the sidebar live.
let _psDebounce = null;
function _projectStatusChanged() {
  if (!window.SessionVerb) return;
  _redrawOpenPicker();
  clearTimeout(_psDebounce);
  _psDebounce = setTimeout(_refreshProjectStatus, 800);
}
setInterval(() => {
  if (document.visibilityState === 'visible' && window.SessionVerb) _refreshProjectStatus();
}, 20000);
document.addEventListener('DOMContentLoaded', () => {
  if (typeof socket === 'undefined' || !socket.on) return;
  ['session_state', 'session_hold', 'state_snapshot'].forEach(ev => socket.on(ev, () => _projectStatusChanged()));
});

/** Fetch every listed project's counts and redraw the open picker. */
function _refreshProjectStatus() {
  if (!window.SessionVerb || !_allProjects || !_allProjects.length) return;
  const seq = ++_projectStatusReq;
  const q = _allProjects.map(p => encodeURIComponent(p.encoded)).join(',');
  const redraw = () => {
    const overlay = document.getElementById('project-overlay');
    if (overlay && overlay.classList.contains('show')) _renderProjectOverlay(true);
  };
  fetch('/api/project-status?projects=' + q, { cache: 'no-store' })
    .then(r => {
      // A web server without the route: back to the session totals.
      if (r.status === 404) { window._projectStatusFailed = true; redraw(); return null; }
      return r.ok ? r.json() : null;
    })
    .then(data => {
      if (!data || seq !== _projectStatusReq) return;
      window._projectStatusFailed = false;
      window._projectStatusCounts = data;
      try { localStorage.setItem(_PS_SAVED, JSON.stringify(data)); } catch (_e) { /* full or private */ }
      const overlay = document.getElementById('project-overlay');
      if (overlay && overlay.classList.contains('show')) _renderProjectOverlay(true);
    })
    .catch(() => {});
}

function _renderProjectOverlay(fromStatus) {
  const list = document.getElementById('project-list');
  if (!list) return;
  // A project is being dragged: a redraw would replace the row under the finger.
  if (window._projDragActive) return;
  // A row just picked is showing "opening": a late count refresh must not
  // redraw it away.  Opening the picker again starts clean.
  if (list.classList.contains('project-picked')) {
    if (fromStatus === true) return;
    list.classList.remove('project-picked');
  }
  if (fromStatus !== true) _refreshProjectStatus();
  const saved = localStorage.getItem('activeProject');

  if (!_allProjects || _allProjects.length === 0) {
    // Loading placeholder — replaced by _refreshProjectsAndRerender() once the
    // fetch settles. Kept generic so it fits both "still loading" and "just
    // opened before startup fetch finished" cases; the error path below
    // replaces this with an explicit error message.
    list.innerHTML = '<div class="empty-state" style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Loading projects…</div>';
    return;
  }

  const _asking = window.VNAllProjects ? VNAllProjects.choosing() : null;
  const _hdr = document.querySelector('#project-card .project-header');
  if (_hdr) {
    const h2 = _hdr.querySelector('h2'), hp = _hdr.querySelector('p');
    if (h2 && !h2.dataset.text) h2.dataset.text = h2.textContent;
    if (hp && !hp.dataset.text) hp.dataset.text = hp.textContent;
    if (h2) h2.textContent = _asking ? _asking.question : h2.dataset.text;
    // The hint line shows only while another feature asks which project;
    // the plain picker carries a project count beside its title instead.
    if (hp) { hp.textContent = _asking ? _asking.hint : ''; hp.hidden = !_asking; }
  }
  const _sub = document.getElementById('project-sub');
  if (_sub) {
    _sub.textContent = _asking ? '' : `${_allProjects.length} ${_allProjects.length === 1 ? 'project' : 'projects'}`;
    _sub.hidden = !!_asking;
  }
  // Edit order: a header button turns on the drag handles; Done turns them off
  // (src/web/project_order.py saves the order).  Not while asking which project.
  const _canReorder = !_asking && _allProjects.length > 1;
  if (!_canReorder) _projEditing = false;
  if (_hdr) {
    let eb = _hdr.querySelector('.project-edit-order');
    if (!eb) {
      eb = document.createElement('button');
      eb.type = 'button';
      eb.className = 'project-edit-order';
      eb.onclick = e => { e.stopPropagation(); _projEditing = !_projEditing; _renderProjectOverlay(true); };
      _hdr.appendChild(eb);
    }
    eb.hidden = !_canReorder;
    eb.textContent = _projEditing ? 'Done' : 'Edit order';
  }
  const _pcard = document.getElementById('project-card');
  if (_pcard) _pcard.classList.toggle('project-editing', _projEditing);
  list.classList.toggle('editing', _projEditing);
  const _customOrder = _allProjects.some(p => p.ordered);
  const _sortLine = _canReorder ? `<div class="project-sortline">${_customOrder
    ? '<span>Your order</span><span aria-hidden="true">·</span><button type="button" class="project-sort-reset">Sort by name</button>'
    : '<span>Sorted by name</span>'}</div>` : '';
  const _inAll = !_asking && !!(window.VNAllProjects && VNAllProjects.on());
  // All projects covers the projects ticked in its Choose list (all-projects.js).
  const _apHas = !!(window.VNAllProjects && VNAllProjects.shown);
  const _apShown = _apHas ? VNAllProjects.shown() : _allProjects;
  const _apNarrow = _apShown.length < _allProjects.length;
  const _total = _apShown.reduce((n, p) => n + (p.session_count || 0), 0);
  const _check = '<svg class="project-item-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Open"><path d="M20 6 9 17l-5-5"/></svg>';
  const _sessions = n => `${n} ${n === 1 ? 'session' : 'sessions'}`;
  // Smart termination on: three columns (Needs you · Standby · Working) in
  // place of the session total; Done is left out (src/web/project_status.py).
  // Drawn at once (empty cells until a first count exists); a web server
  // without the route keeps the total.
  const _cols = !_asking && !!window.SessionVerb && !window._projectStatusFailed;
  list.classList.toggle('ps-cols-on', _cols);
  // Asking which project (New Session in All projects): nothing is picked yet,
  // so no row is marked open, and rename / delete stay out of a chooser.
  list.classList.toggle('project-choosing', !!_asking);
  const _pc = _cols ? Object.assign({}, window._projectStatusCounts || {}, _localProjectCounts()) : {};
  const _colsHtml = c => '<span class="ps-cols">' + _PS_GROUPS.map(g => {
    const n = c ? (c[g] || 0) : null;
    return n ? `<span class="ps-n vs-${g}" title="${n} ${_PS_LABEL[g].toLowerCase()}">${n}</span>`
             : `<span class="ps-n zero">${n === null ? '' : '·'}</span>`;
  }).join('') + '</span>';
  const _allCounts = {};
  _apShown.forEach(p => { const c = _pc[p.encoded]; if (c) _PS_GROUPS.forEach(g => { _allCounts[g] = (_allCounts[g] || 0) + (c[g] || 0); }); });
  const _head = _cols ? '<div class="ps-head" aria-hidden="true"><span></span>' +
    _PS_GROUPS.map(g => `<span title="${_PS_LABEL[g]}">${_psIcon(g)}</span>`).join('') + '</div>' : '';
  const _allRow = (window.VNAllProjects && !_asking) ? `
    <div class="project-item project-item-all${_inAll ? ' active' : ''}" data-encoded="${VNAllProjects.ALL}" title="Every project's sessions in one list">
      <span class="project-item-mark" aria-hidden="true">\u2217</span>
      <div class="project-item-info">
        <div class="project-item-name"><span>All projects</span>${_inAll ? _check : ''}</div>
        <div class="project-item-path">${_apNarrow ? escHtml(_apShown.map(_projectShortName).join(', ')) : 'Every session in one list'}</div>
      </div>
      <div class="project-item-right">${_apHas
        ? `<button type="button" class="ap-choose" aria-expanded="${_apChooseOpen}" title="Choose which projects All projects shows">${_apChooseOpen ? 'Done' : 'Choose…'}</button>`
        : (_cols ? _colsHtml(_allCounts) : `<span class="project-item-count" title="${_sessions(_total)}">${_total}</span>`)}</div>
    </div>
    ${(_apHas && _apChooseOpen) ? '<div class="ap-sub">' + _allProjects.map(p => {
      const nm = _projectShortName(p);
      return `<label><input type="checkbox" data-ap="${escHtml(p.encoded)}"${VNAllProjects.included(p.encoded) || !_apNarrow ? ' checked' : ''}><span>${escHtml(nm)}</span></label>`;
    }).join('') + '</div>' : ''}
    <div class="project-sep" aria-hidden="true"></div>` : '';
  const _addRow = _asking ? '' : `
    <div class="project-sep" aria-hidden="true"></div>
    <div class="project-item project-item-add" role="button" tabindex="0">
      <span class="project-item-mark" aria-hidden="true">+</span>
      <div class="project-item-info"><div class="project-item-name">Add project</div></div>
    </div>`;
  // All projects sits first, then the projects, then Add project.  Asking
  // which project from All projects (New Session, Workflow, Subsessions)
  // offers only the projects that view covers.
  const _rows = (_asking && _apHas && VNAllProjects.on()) ? _apShown : _allProjects;
  list.innerHTML = _sortLine + _head + _allRow + _rows.map(p => {
    const shortName = _projectShortName(p);
    const isActive = !_inAll && !_asking && p.encoded === saved;
    return `
    <div class="project-item${isActive ? ' active' : ''}" data-encoded="${escHtml(p.encoded)}" data-name="${escHtml(shortName)}" title="${escHtml(p.display)}">
      <span class="project-item-mark${p.phoned ? ' project-item-phoned' : ''}" style="--h:${_projectHue(shortName)}" aria-hidden="true">${p.phoned ? _PHONED_PROJECT_SVG : escHtml((shortName || '?').trim().charAt(0).toUpperCase())}</span>
      <div class="project-item-info">
        <div class="project-item-name"><span>${escHtml(shortName)}</span>${isActive ? _check : ''}</div>
        <div class="project-item-path">${escHtml(_projectShortPath(p.display))}</div>
      </div>
      <div class="project-item-right">
      ${_cols ? _colsHtml(_pc[p.encoded]) : `<span class="project-item-count" title="${_sessions(p.session_count)}">${p.session_count}</span>`}
      <div class="project-item-actions">
        <button class="project-act-btn project-rename-btn" title="Rename">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="project-act-btn danger project-delete-btn" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
      </div>
      ${_canReorder ? `<button type="button" class="project-grip" aria-label="Drag to reorder ${escHtml(shortName)}" title="Drag to reorder">${_PROJECT_GRIP_SVG}</button>` : ''}
    </div>`;
  }).join('') + _addRow;

  const _reset = list.querySelector('.project-sort-reset');
  if (_reset) _reset.onclick = e => { e.stopPropagation(); _saveProjectOrder([]); };
  if (_projEditing) _wireProjectReorder(list);

  // Event delegation for project items
  const _allItem = list.querySelector('.project-item-all');
  if (_allItem) _allItem.onclick = () => selectProjectFromOverlay(VNAllProjects.ALL);
  // Choose… opens the list of projects under the row; Done closes it, and
  // opens All projects when it is not open yet.
  const _choose = list.querySelector('.ap-choose');
  if (_choose) _choose.onclick = e => {
    e.stopPropagation();
    const closing = _apChooseOpen;
    _apChooseOpen = !_apChooseOpen;
    try { if (_apChooseOpen) localStorage.setItem('vnApChooseOpen', '1'); else localStorage.removeItem('vnApChooseOpen'); } catch (e2) {}
    if (closing && !VNAllProjects.on()) { selectProjectFromOverlay(VNAllProjects.ALL); return; }
    _renderProjectOverlay(true);
  };
  list.querySelectorAll('.ap-sub input[data-ap]').forEach(cb => {
    cb.onclick = e => e.stopPropagation();
    cb.onchange = () => {
      if (!VNAllProjects.setIncluded(cb.dataset.ap, cb.checked)) {
        cb.checked = true;
        if (typeof showToast === 'function') showToast('Keep at least one project in All projects');
        return;
      }
      _renderProjectOverlay(true);
      _apSubsetChanged();
    };
  });
  const _addItem = list.querySelector('.project-item-add');
  if (_addItem) {
    _addItem.onclick = () => addProjectOverlay();
    _addItem.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addProjectOverlay(); } };
  }
  list.querySelectorAll('.project-item:not(.project-item-all):not(.project-item-add)').forEach(item => {
    const enc = item.dataset.encoded;
    const name = item.dataset.name;
    // In Edit order a tap never opens a project (nor the one a drag just let go).
    item.onclick = () => { if (_projEditing || item._dragged) return; selectProjectFromOverlay(enc); };
    item.querySelector('.project-rename-btn').onclick = e => { e.stopPropagation(); renameProjectOverlay(enc, name); };
    item.querySelector('.project-delete-btn').onclick = e => { e.stopPropagation(); deleteProjectOverlay(enc, name); };
    // Right-click offers the same Rename and Delete as the row's hover buttons,
    // in the session menu's look. Not while asking which project to use: that
    // list hides rename and delete.
    if (!_asking) item.oncontextmenu = e => _projectContextMenu(e, enc, name);
  });
}

// ── Edit order: drag projects into your own order ──
// Live like the pinned sessions: the row lifts and follows the pointer, the
// others slide out of its way, letting go saves the whole order.  A mouse can
// grab a row anywhere; a finger grabs the handle, so the list still scrolls.
let _projEditing = false;
const _PROJECT_GRIP_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

/** Save ``order`` (encoded ids, first on top; [] = sort by name) and redraw
 *  from the server's list.  A save that fails puts the old list back. */
async function _saveProjectOrder(order) {
  const before = _allProjects.slice();
  if (order.length) {
    const rank = new Map(order.map((e, i) => [e, i]));
    _allProjects = _allProjects.slice().sort((a, b) => rank.get(a.encoded) - rank.get(b.encoded))
      .map(p => Object.assign({}, p, { ordered: true }));
    _renderProjectOverlay(true);
  }
  try {
    const res = await fetch('/api/project-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const fresh = await fetch('/api/projects', { cache: 'no-store' });
    if (fresh.ok) _allProjects = await fresh.json();
    if (!order.length && typeof showToast === 'function') showToast('Back to sorting by name');
  } catch (e) {
    _allProjects = before;
    if (typeof showToast === 'function') showToast("Couldn't save the project order. Try again.", true);
  }
  _renderProjectOverlay(true);
}

function _wireProjectReorder(list) {
  const SEL = '.project-item[data-encoded]:not(.project-item-all):not(.project-item-add)';
  let st = null;

  function lift(row, y) {
    const rows = [...list.querySelectorAll(SEL)];
    const s0 = list.scrollTop;
    // Positions in the list's own coordinates, so scrolling while dragging is fine.
    const rects = rows.map(r => { const b = r.getBoundingClientRect(); return { top: b.top + s0, bottom: b.bottom + s0, h: b.height }; });
    const from = rows.indexOf(row);
    st = { row, rows, rects, from, to: from, y0: y + s0, y: y, raf: 0 };
    window._projDragActive = true;
    row.classList.add('lifting');
    list.classList.add('dragging');
    rows.forEach(r => { if (r !== row) r.classList.add('sliding'); });
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
    move(y);
    autoScroll();
  }
  function move(y) {
    st.y = y;
    const r0 = st.rects[st.from];
    const first = st.rects[0], last = st.rects[st.rects.length - 1];
    const dy = Math.max(first.top - r0.top, Math.min(last.bottom - r0.bottom, (y + list.scrollTop) - st.y0));
    st.row.style.transform = `translateY(${dy}px) scale(1.02)`;
    const mid = r0.top + r0.h / 2 + dy;
    let to = st.from;
    st.rects.forEach((r, i) => {
      if (i < st.from && mid <= r.top + r.h / 2) to = Math.min(to, i);
      if (i > st.from && mid >= r.top + r.h / 2) to = Math.max(to, i);
    });
    st.to = to;
    st.rows.forEach((r, i) => {
      if (r === st.row) return;
      let s = 0;
      if (st.from < to && i > st.from && i <= to) s = -r0.h;
      if (st.from > to && i >= to && i < st.from) s = r0.h;
      r.style.transform = s ? `translateY(${s}px)` : '';
    });
  }
  // Near the list's top or bottom edge, scroll it so a long list can be crossed.
  function autoScroll() {
    if (!st) return;
    const b = list.getBoundingClientRect();
    const edge = 48;
    const v = st.y < b.top + edge ? -Math.ceil((b.top + edge - st.y) / 6)
            : st.y > b.bottom - edge ? Math.ceil((st.y - (b.bottom - edge)) / 6) : 0;
    if (v) { const before = list.scrollTop; list.scrollTop += v; if (list.scrollTop !== before) move(st.y); }
    st.raf = requestAnimationFrame(autoScroll);
  }
  function drop(cancel) {
    if (!st) return;
    const d = st; st = null;
    cancelAnimationFrame(d.raf);
    const to = cancel ? d.from : d.to;
    const r0 = d.rects[d.from], rt = d.rects[to];
    d.row.classList.add('settling');
    d.row.style.transform = `translateY(${to === d.from ? 0 : (to > d.from ? rt.bottom - r0.bottom : rt.top - r0.top)}px)`;
    if (cancel) d.rows.forEach(r => { if (r !== d.row) r.style.transform = ''; });
    d.row._dragged = true;
    setTimeout(() => {
      d.rows.forEach(r => { r.style.transform = ''; r.classList.remove('sliding', 'lifting', 'settling'); });
      list.classList.remove('dragging');
      window._projDragActive = false;
      if (to !== d.from) {
        const order = d.rows.map(r => r.dataset.encoded);
        order.splice(to, 0, order.splice(d.from, 1)[0]);
        _saveProjectOrder(order);
      }
      setTimeout(() => { d.row._dragged = false; }, 250);
    }, 170);
  }

  list.querySelectorAll(SEL).forEach(row => {
    row.addEventListener('pointerdown', e => {
      if (e.button > 0 || st) return;
      const onGrip = !!e.target.closest('.project-grip');
      if (e.pointerType !== 'mouse' && !onGrip) return;   // a finger elsewhere scrolls the list
      if (onGrip) e.preventDefault();
      const y0 = e.clientY;
      const mv = ev => {
        if (st) { ev.preventDefault(); move(ev.clientY); return; }
        if (Math.abs(ev.clientY - y0) > 4) { lift(row, y0); move(ev.clientY); }
      };
      const tm = ev => { if (st) ev.preventDefault(); };
      const done = cancel => {
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cn);
        window.removeEventListener('keydown', esc, true);
        document.removeEventListener('touchmove', tm);
        drop(cancel);
      };
      const up = () => done(false);
      const cn = () => done(true);
      const esc = ev => { if (ev.key === 'Escape' && st) { ev.stopPropagation(); done(true); } };
      window.addEventListener('pointermove', mv, { passive: false });
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cn);
      window.addEventListener('keydown', esc, true);
      document.addEventListener('touchmove', tm, { passive: false });
    });
  });
}

// Right-click menu on a project row: Rename and Delete, drawn with the session
// right-click menu's classes so the two menus look the same.
function _projectContextMenu(e, encoded, name) {
  e.preventDefault();
  e.stopPropagation();
  const old = document.querySelector('.session-ctx-menu');
  if (old) old.remove();
  const icons = (typeof _ICONS !== 'undefined') ? _ICONS : {};
  const items = [
    { label: 'Rename', icon: icons.rename, action: 'rename' },
    { divider: true },
    { label: 'Delete', icon: icons.trash, action: 'delete', danger: true },
  ];
  const run = action => {
    const m = document.querySelector('.session-ctx-menu');
    if (m) m.remove();
    if (typeof _closeSessionSheet === 'function') _closeSessionSheet();
    if (action === 'rename') renameProjectOverlay(encoded, name);
    else if (action === 'delete') deleteProjectOverlay(encoded, name);
  };
  if (typeof _isMobileCtx === 'function' && _isMobileCtx() && typeof _openSessionSheet === 'function') {
    _openSessionSheet(items, run);
    return;
  }
  const icon = i => (i && typeof _iconDesktop === 'function') ? _iconDesktop(i) : '';
  const menu = document.createElement('div');
  menu.className = 'session-ctx-menu ws-ctx-menu project-ctx-menu';
  menu.innerHTML = items.map(it => it.divider
    ? '<div class="ws-ctx-divider"></div>'
    : '<div class="ws-ctx-item' + (it.danger ? ' danger' : '') + '" data-action="' + it.action + '">'
      + icon(it.icon) + '<span class="vn-ctx-lbl">' + escHtml(it.label) + '</span></div>').join('');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.addEventListener('click', ev => {
    ev.stopPropagation();
    const row = ev.target.closest('[data-action]');
    if (row) run(row.dataset.action);
  });
  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
  });
  const closer = ev => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', closer, true);
      document.removeEventListener('contextmenu', closer, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closer, true);
    document.addEventListener('contextmenu', closer, true);
  }, 0);
}

async function _refreshProjectsAndRerender() {
  // Plain fetch — NOT loadProjects(), because loadProjects() also updates the
  // sidebar label and can trigger setProject() (which tears down live panels).
  // Here we just want to repopulate the cache so the overlay can re-render.
  try {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _allProjects = await res.json();
  } catch (e) {
    // A failed background refresh keeps the rows already on screen.
    if (_allProjects && _allProjects.length) return;
    const list = document.getElementById('project-list');
    if (list) {
      list.innerHTML = '<div class="empty-state" style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Couldn\'t load projects. Check your connection and tap "Select project" again.</div>';
    }
    return;
  }
  // Only re-render if the overlay is still visible (user may have closed it
  // while the fetch was in flight).
  const overlay = document.getElementById('project-overlay');
  if (overlay && overlay.classList.contains('show')) {
    // Opening the picker already asked for counts; a second request here
    // used to cancel that one and double the wait.
    _renderProjectOverlay(true);
  }
  // Also update the sidebar label if it was showing the placeholder — the
  // startup loadProjects() may have failed before it got a chance to set it.
  const saved = localStorage.getItem('activeProject');
  const savedMatch = _allProjects.find(p => p.encoded === saved);
  if (savedMatch) _updateProjectLabel(savedMatch);
  else if (_allProjects.length > 0) _updateProjectLabel(_allProjects[0]);
}

function closeProjectOverlay() {
  _closeChoiceOverlay();
  document.getElementById('project-overlay').classList.remove('show');
  // A question it was asking (all-projects.js chooser) is answered "none".
  if (window.VNAllProjects && VNAllProjects.choosing()) VNAllProjects.finishChoice(null);
}

/** Close the picker after it answered a question (selectProjectFromOverlay):
 *  hidden, and its "opening" marks cleared for the next time it opens. */
function _closeChoiceOverlay() {
  const list = document.getElementById('project-list');
  // Only the picker that answered: one opened since then was redrawn and lost the mark.
  if (!list || !list.classList.contains('project-picked')) return;
  list.classList.remove('project-picked');
  list.querySelectorAll('.project-picking').forEach(r => r.classList.remove('project-picking'));
  list.querySelectorAll('.project-picking-spin').forEach(s => s.remove());
  const overlay = document.getElementById('project-overlay');
  if (overlay) overlay.classList.remove('show');
}

async function selectProjectFromOverlay(encoded) {
  // The picker was asking a question (New Session in All projects): answer it.
  // The click shows at once: the row is marked as opening and the picker
  // stays up until whatever asked has drawn its result (New Session closes
  // it once the empty session is on screen; it took ~0.7 s with nothing
  // shown).  A backstop closes it if nothing does.
  if (window.VNAllProjects && VNAllProjects.choosing()) {
    const overlay = document.getElementById('project-overlay');
    const list = document.getElementById('project-list');
    const row = list && Array.from(list.querySelectorAll('.project-item')).find(r => r.dataset.encoded === encoded);
    if (list) list.classList.add('project-picked');
    if (row) {
      row.classList.add('project-picking');
      const right = row.querySelector('.project-item-right');
      if (right) right.insertAdjacentHTML('afterbegin', '<span class="project-picking-spin" aria-label="Opening"></span>');
    }
    // Let the browser paint the feedback before the work that follows blocks it.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    VNAllProjects.finishChoice(encoded);
    setTimeout(() => _closeChoiceOverlay(), 4000);
    return;
  }
  closeProjectOverlay();
  // The project being left: its tile slides out as the new one slides in.
  const _fromP = _allProjects.find(x => x.encoded === localStorage.getItem('activeProject'));
  const fromName = (window.VNAllProjects && VNAllProjects.on()) ? 'All projects' : (_fromP ? _projectShortName(_fromP) : '');
  // All projects (all-projects.js): a view over every project; the active
  // project stays the current one until a session from another is opened.
  const _toAll = !!(window.VNAllProjects && encoded === VNAllProjects.ALL);
  if (window.VNAllProjects) VNAllProjects.set(_toAll);
  if (_toAll) encoded = localStorage.getItem('activeProject') || ((_allProjects[0] || {}).encoded) || '';
  const p = _allProjects.find(x => x.encoded === encoded);
  const name = _toAll ? (VNAllProjects.label ? VNAllProjects.label() : 'All projects') : (p ? _projectShortName(p) : 'project');
  const count = _toAll ? (VNAllProjects.shown ? VNAllProjects.shown() : _allProjects).reduce((n, x) => n + (x.session_count || 0), 0) : (p ? p.session_count : null);

  // Show the full-screen splash.  The floor only exists so the splash can
  // finish revealing the project name instead of flashing up and straight
  // back down; it is NOT a pacing device.  It used to be 1800ms, which meant
  // every switch waited on the animation long after the data was ready.
  _showProjectSwitchLoader(name, fromName, count);
  const _minDisplay = new Promise(r => setTimeout(r, 400));
  // Let the splash go opaque BEFORE the old project is torn down, so the
  // teardown itself is never seen.
  await new Promise(r => setTimeout(r, 170));

  _projectSwitchLoad = null;
  await setProject(encoded, true);

  // A project switch always lands on Sessions: the sidebar has no view
  // switcher, so restoring another view would strand the user there.
  if (typeof setViewMode === 'function') setViewMode('sessions');

  // Hold the splash until the new project has actually finished drawing:
  // the session list has loaded (setProject starts that load but does not
  // wait for it) and any restored session's thread is on screen.  Lifting it
  // on the timer alone revealed the half-built states underneath.
  try { if (_projectSwitchLoad) await _projectSwitchLoad; } catch (e) { /* load failures surface in the list itself */ }
  await _projectSwitchSettled(3000);
  await _minDisplay;
  _hideProjectSwitchLoader();
}

// Project-switch splash: the loading splash (".vn-splash", styled inline in
// index.html), naming the project being opened.  It is OPAQUE on purpose.  The
// old loader was a translucent blur, and a switch tears the old project down
// and builds the new one in several steps (empty dashboard, sessions known
// from the live snapshot before the list arrives, the list, the restored
// session's thread), every one of which showed through it as stale data.
// The old project's tile slides out as the new one's slides in, and the name
// under them swaps; with no old name, or the same one, the new tile pops in.
function _showProjectSwitchLoader(projectName, fromName, sessionCount) {
  let overlay = document.getElementById('project-switch-loader');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'project-switch-loader';
  overlay.className = 'vn-splash vn-switch';
  overlay.setAttribute('aria-hidden', 'true');
  const both = !!fromName && fromName !== projectName;
  const initial = n => escHtml((String(n).trim()[0] || '?').toUpperCase());
  const tile = (n, kind) => '<div class="vns-tile ' + kind + '">'
    + (kind === 'new' ? '<svg viewBox="0 0 76 76"><rect x="1" y="1" width="74" height="74" rx="22" pathLength="100"/></svg>' : '')
    + '<b>' + initial(n) + '</b></div>';
  overlay.innerHTML = '<div class="vns-lane' + (both ? '' : ' vns-solo') + '">'
    + (both ? tile(fromName, 'old') : '') + tile(projectName, 'new') + '</div>'
    + '<div class="vns-names">' + (both ? '<span class="vns-was">' + escHtml(fromName) + '</span>' : '')
    + '<span class="vns-now">' + escHtml(projectName) + '</span></div>'
    + (typeof sessionCount === 'number'
      ? '<div class="vns-count">' + sessionCount + (sessionCount === 1 ? ' session' : ' sessions') + '</div>' : '');
  document.body.appendChild(overlay);
  overlay.offsetHeight;   // force reflow so the fade-in runs
  overlay.classList.add('in');
}

function _hideProjectSwitchLoader() {
  const overlay = document.getElementById('project-switch-loader');
  if (!overlay) return;
  overlay.classList.add('ready');   // the bar completes
  setTimeout(() => {
    overlay.classList.add('out');
    setTimeout(() => overlay.remove(), 600);
  }, 180);
}

// Resolves once the new project has finished drawing: the session list is
// loaded and, if a session was restored, its thread has replaced its skeleton.
// Capped, so a slow or failed load can never leave the splash up.
function _projectSwitchSettled(maxMs) {
  const t0 = performance.now();
  return new Promise(resolve => {
    (function check() {
      const sl = document.getElementById('session-list');
      const listLoading = !!(sl && sl.getClientRects().length && sl.querySelector('.skel-row, .skel-cards'));
      const threadLoading = !!document.querySelector('#live-log .skel-bar');
      if ((!listLoading && !threadLoading) || performance.now() - t0 > maxMs) { resolve(); return; }
      setTimeout(check, 50);
    })();
  });
}

async function renameProjectOverlay(encoded, currentName) {
  // Close the project overlay first so the prompt dialog has a clean backdrop
  closeProjectOverlay();
  const newName = await showPrompt('Rename Project', '<p>Enter a display name for this project. The directory stays the same.</p>', {
    placeholder: 'Project name',
    value: currentName,
    confirmText: 'Rename',
  });
  if (newName === null || newName === currentName) return;
  // Save to server (project rename endpoint)
  try {
    const resp = await fetch('/api/rename-project', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({encoded, name: newName})
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Renamed to "' + newName + '"');
      // Refresh project list and update the label without a full reload
      const res = await fetch('/api/projects');
      _allProjects = await res.json();
      const p = _allProjects.find(x => x.encoded === encoded);
      if (p) _updateProjectLabel(p);
    } else {
      showToast(data.error || 'Rename failed', true);
    }
  } catch(e) {
    showToast('Rename failed', true);
  }
}

async function deleteProjectOverlay(encoded, name) {
  const confirmed = await showConfirm('Delete Project', `<p>Delete <strong>${escHtml(name)}</strong> and all its sessions?</p><p>This cannot be undone.</p>`, {
    danger: true,
    confirmText: 'Delete',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  });
  if (!confirmed) return;
  try {
    const resp = await fetch('/api/delete-project', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({encoded})
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Project deleted');
      await loadProjects();
      openProjectOverlay();
    } else {
      showToast(data.error || 'Delete failed', true);
    }
  } catch(e) {
    showToast('Delete failed', true);
  }
}

function addProjectOverlay() {
  // Replace the project list with mode picker
  const list = document.getElementById('project-list');

  list.innerHTML = `
    <div style="padding:8px 16px 16px;">
      <div class="add-mode-card" onclick="addProjectBrowse()">
        <div class="add-mode-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="add-mode-info">
          <div class="add-mode-title">Browse</div>
          <div class="add-mode-desc">Pick a folder from your computer</div>
        </div>
      </div>
      <div class="add-mode-card" onclick="addProjectFind()">
        <div class="add-mode-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
        <div class="add-mode-info">
          <div class="add-mode-title">Find Projects</div>
          <div class="add-mode-desc">Scan your computer for code projects</div>
        </div>
      </div>
      <div class="add-mode-card" onclick="addProjectCreate()">
        <div class="add-mode-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </div>
        <div class="add-mode-info">
          <div class="add-mode-title">Create New</div>
          <div class="add-mode-desc">Start a new empty project</div>
        </div>
      </div>
      <button class="pm-btn pm-btn-secondary" onclick="openProjectOverlay()" style="width:100%;margin-top:8px;">Back to Projects</button>
    </div>`;
}

async function addProjectBrowse() {
  // Keep the project overlay open while the native folder picker is up.
  // Native OS dialogs always render above browser content, so the picker
  // appears on top of the modal. If we closed the modal here and the picker
  // hung (e.g. dialog opening behind Chrome on a fresh Windows install),
  // the user would have no way to recover without refreshing the page.
  showToast('Opening folder picker\u2026');
  console.log('[addProjectBrowse] POST /api/add-project mode=browse');
  try {
    const resp = await fetch('/api/add-project', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({mode:'browse'}) });
    const data = await resp.json();
    console.log('[addProjectBrowse] response', resp.status, data);
    if (data.cancelled) { openProjectOverlay(); return; }
    if (data.ok) {
      showToast('Added ' + data.path);
      await loadProjects();
      openProjectOverlay();
    } else {
      const errMsg = data.error || ('Add failed (HTTP ' + resp.status + ')');
      console.error('[addProjectBrowse] failed:', errMsg, data);
      showToast(errMsg, true);
      openProjectOverlay();
    }
  } catch(e) {
    console.error('[addProjectBrowse] exception:', e);
    showToast('Add failed: ' + (e && e.message ? e.message : e), true);
    openProjectOverlay();
  }
}

let _findChat = null;

function addProjectFind() {
  const list = document.getElementById('project-list');
  list.style.padding = '0';

  // Destroy previous chat if any
  if (_findChat) { _findChat.destroy(); _findChat = null; }

  list.innerHTML = '<div id="find-chat-container" style="height:340px;"></div>'
    + '<div style="padding:8px 16px 12px;"><button class="pm-btn pm-btn-secondary" onclick="destroyFindChat();openProjectOverlay();" style="width:100%;">Back to Projects</button></div>';

  const container = document.getElementById('find-chat-container');
  _findChat = new ChatComponent(container, {
    placeholder: 'Describe the project you\'re looking for\u2026',
    systemMessage: 'Tell me what project you\'re looking for \u2014 I\'ll search your computer. Try something like "my Python web app" or "the React project I was working on".',
    suggestions: ['Python projects', 'Node.js apps', 'Git repositories', 'Recent code projects'],
    onSend: async (text, messages) => {
      // Check if user clicked an "Add" suggestion
      const addMatch = text.match(/^(.+?)\s*\u2014\s*Add$/);
      if (addMatch && _lastFindMatches) {
        const match = _lastFindMatches.find(m => m.name === addMatch[1]);
        if (match) {
          try {
            const r = await fetch('/api/add-project', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({mode:'path', path: match.path}) });
            const d = await r.json();
            if (d.ok) {
              showToast('Added ' + match.name);
              await loadProjects();
              return { content: '**' + match.name + '** has been added! You can search for more or go back to your projects.', suggestions: ['Back to projects'] };
            }
          } catch(e) {}
          return 'Failed to add that project. Try again.';
        }
      }
      if (text === 'Back to projects') {
        destroyFindChat();
        openProjectOverlay();
        return null;
      }
      if (text === 'Browse for folder') {
        destroyFindChat();
        addProjectBrowse();
        return null;
      }

      // Search via backend
      const resp = await fetch('/api/project-chat', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({message: text})
      });
      const data = await resp.json();
      _lastFindMatches = data.matches || [];
      return { content: data.content, suggestions: data.suggestions || [] };
    }
  });
}

let _lastFindMatches = [];

function destroyFindChat() {
  if (_findChat) { _findChat.destroy(); _findChat = null; }
  _lastFindMatches = [];
  const list = document.getElementById('project-list');
  if (list) list.style.padding = '';
}

async function addProjectCreate() {
  const name = await showPrompt('Create Project', '<p>Enter a name for your new project.</p>', {
    placeholder: 'My Project',
    confirmText: 'Create',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  });
  if (!name) return;
  try {
    const resp = await fetch('/api/add-project', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({mode:'create', name})
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('Created ' + name);
      await loadProjects();
      openProjectOverlay();
    } else { showToast(data.error || 'Create failed', true); }
  } catch(e) { showToast('Create failed', true); }
}

// --- Sidebar collapse ---
// Only the desktop layout saves or restores a hidden panel.  The phone layout
// (<= 768px) uses the same .collapsed class as its drawer and closes it every
// time a session opens; saving that under the desktop's key hid the desktop
// panel on its next load whenever the same browser had been at phone width
// (a narrow window, a phone-size preview frame).  The key was renamed so a
// value the phone layout wrote earlier is not read.  Tests:
// tests/test_sidebar_collapse.py.
const _SIDEBAR_HIDDEN_KEY = 'sidebarHiddenDesktop';
const _sidebarDesktop = () => window.matchMedia('(min-width: 769px)').matches;
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const expandBtn = document.getElementById('btn-sidebar-expand');
  const collapsed = sidebar.classList.toggle('collapsed');
  expandBtn.classList.toggle('visible', collapsed);
  if (_sidebarDesktop()) localStorage.setItem(_SIDEBAR_HIDDEN_KEY, collapsed ? '1' : '');
}
// Restore on load (desktop only; the phone layout opens and closes its drawer itself)
if (_sidebarDesktop() && localStorage.getItem(_SIDEBAR_HIDDEN_KEY) === '1') {
  document.querySelector('.sidebar').classList.add('collapsed');
  document.getElementById('btn-sidebar-expand').classList.add('visible');
}

// --- View mode selector ---
const _viewModes = {
  homepage: {
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    label: 'Home',
    title: 'Home',
    desc: 'DevelopNode homepage',
  },
  sessions: {
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
    label: 'Sessions View',
    title: 'Sessions',
    desc: 'Run and interact with your Claude Code sessions',
  },
  kanban: {
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="15" rx="1"/></svg>',
    label: 'Workflow View',
    title: 'Workflow',
    desc: 'Task board with workflow columns and AI session orchestration',
  },
  workplace: {
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><circle cx="7" cy="10" r="1.5"/><circle cx="17" cy="10" r="1.5"/><path d="M10 10h4"/></svg>',
    label: 'Workforce View',
    title: 'Workforce',
    desc: 'Knowledge asset library — manage skills and agent definitions',
  },
  compose: {
    icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
    label: 'Subsessions View',
    title: 'Subsessions',
    desc: 'Documents, diagrams, and knowledge creation board',
  },
};

function _updateViewModeButton(mode) {
  // The sidebar's "Sessions" back button shows only outside Sessions.
  const back = document.getElementById('sidebar-nav');
  if (back) back.hidden = (mode === 'sessions');
}

// Hydrate view mode button on load
_updateViewModeButton(viewMode);

// Hydrate sort label on load
(function() {
  const opts = document.querySelectorAll('.sidebar-sort-opt');
  opts.forEach(el => {
    if (el.dataset.sort === sortMode && String(el.dataset.asc) === String(sortAsc)) {
      el.classList.add('active');
      const sortLabel = document.getElementById('sidebar-sort-label');
      if (sortLabel) sortLabel.textContent = el.textContent;
    }
  });
})();

// --- Sidebar menu (three dots) ---
function toggleSidebarMenu() {
  _syncSortMenu();
  closeFilterMenu();   // one open menu at a time
  const dd = document.getElementById('sidebar-menu-dropdown');
  // On a phone the menu is a bottom sheet; its lists open in place with Back.
  if (typeof _isMobileCtx === 'function' && _isMobileCtx() && typeof _menuToSheet === 'function') {
    dd.classList.remove('open');
    _menuToSheet(dd);
    return;
  }
  dd.querySelectorAll('.vn-ctx-has-sub.open').forEach(function(o) { o.classList.remove('open'); });
  dd.classList.toggle('open');
}
function closeSidebarMenu() {
  const dd = document.getElementById('sidebar-menu-dropdown');
  dd.classList.remove('open');
  dd.querySelectorAll('.vn-ctx-has-sub.open').forEach(function(o) { o.classList.remove('open'); });
}
// A row with › opens its list beside the menu on hover, focus or click, one at a time.
(function() {
  function openSub(row) {
    const dd = row.closest('.sidebar-menu-dropdown');
    dd.querySelectorAll('.vn-ctx-has-sub.open').forEach(function(o) { if (o !== row) o.classList.remove('open'); });
    row.classList.add('open');
    // The sidebar clips what leaves it, so the list is pinned to the screen
    // beside the menu (to its left when there is no room on the right).
    const fly = row.querySelector('.vn-ctx-flyout');
    if (!fly) return;
    const m = dd.getBoundingClientRect(), r = row.getBoundingClientRect();
    fly.style.position = 'fixed';
    fly.style.top = Math.max(8, Math.min(r.top - 6, window.innerHeight - fly.offsetHeight - 8)) + 'px';
    const left = m.right + 6;
    fly.style.left = (left + fly.offsetWidth > window.innerWidth - 8 ? Math.max(8, m.left - 6 - fly.offsetWidth) : left) + 'px';
    fly.style.right = 'auto';
  }
  document.addEventListener('mouseover', function(e) {
    const dd = e.target.closest && e.target.closest('.sidebar-menu-dropdown');
    if (!dd) return;
    const row = e.target.closest('.sidebar-menu-sub');
    if (row && row.parentElement === dd) openSub(row);
    else if (!e.target.closest('.vn-ctx-flyout') && e.target.parentElement === dd) {
      dd.querySelectorAll('.vn-ctx-has-sub.open').forEach(function(o) { o.classList.remove('open'); });
    }
  });
  document.addEventListener('click', function(e) {
    const row = e.target.closest && e.target.closest('.sidebar-menu-sub');
    if (row && !e.target.closest('.vn-ctx-flyout')) openSub(row);
  });
  document.addEventListener('focusin', function(e) {
    const row = e.target.closest && e.target.closest('.sidebar-menu-sub');
    if (row && e.target === row) openSub(row);
  });
})();

// --- Filter menu (funnel), see "Session filters" ---
function toggleFilterMenu() {
  closeSidebarMenu();
  const dd = document.getElementById('sidebar-filter-dropdown');
  if (dd && typeof _isMobileCtx === 'function' && _isMobileCtx() && typeof _menuToSheet === 'function') {
    dd.classList.remove('open');
    _menuToSheet(dd, { keepOpen: '.sidebar-filter-opt' });   // several filters can be ticked
    return;
  }
  if (dd) dd.classList.toggle('open');
}
function closeFilterMenu() {
  const dd = document.getElementById('sidebar-filter-dropdown');
  if (dd) dd.classList.remove('open');
}

function pickSort(mode, asc) {
  closeSidebarMenu();
  // Find the label from the clicked option
  const opts = document.querySelectorAll('.sidebar-sort-opt');
  let label = mode;
  opts.forEach(el => {
    const match = el.dataset.sort === mode && String(el.dataset.asc) === String(asc);
    el.classList.toggle('active', match);
    if (match) label = el.textContent;
  });
  const sortLabel = document.getElementById('sidebar-sort-label');
  if (sortLabel) sortLabel.textContent = label;
  // Apply and REMEMBER the choice.  Both views read the same choice, so it is
  // written to every key here rather than through setSort()/setWfSort():
  // setSort() toggles direction when the mode is unchanged (right for a column
  // header click, wrong for a menu pick) and neither stored the direction.
  sortMode = mode;
  sortAsc = !!asc;
  wfSort = (mode === 'date') ? 'recent' : mode;
  localStorage.setItem('sortMode', sortMode);
  localStorage.setItem('sortAsc', sortAsc);
  localStorage.setItem('wfSort', wfSort);
  filterSessions();
}

/** Tick the menu entry that matches the remembered sort. */
function _syncSortMenu() {
  const mode = (typeof sessionDisplayMode !== 'undefined' && sessionDisplayMode === 'grid' && viewMode === 'sessions')
    ? (wfSort === 'recent' ? 'date' : wfSort) : sortMode;
  document.querySelectorAll('.sidebar-sort-opt[data-sort]').forEach(el => {
    const sameDir = el.dataset.sort === 'status' || String(el.dataset.asc) === String(!!sortAsc);
    el.classList.toggle('active', el.dataset.sort === mode && sameDir);
  });
  // The ••• menu shows the current sort and display beside their rows.
  const active = document.querySelector('.sidebar-sort-opt[data-sort].active');
  const sv = document.getElementById('sidebar-menu-sort-val');
  if (sv) sv.textContent = active ? active.textContent : '';
  const dm = (typeof sessionDisplayMode !== 'undefined') ? sessionDisplayMode : '';
  document.querySelectorAll('.sidebar-sort-opt[data-display]').forEach(el => {
    el.classList.toggle('active', el.dataset.display === dm);
  });
  const shown = document.querySelector('.sidebar-sort-opt[data-display].active');
  const dv = document.getElementById('sidebar-menu-display-val');
  if (dv) dv.textContent = shown ? shown.textContent : '';
}

// Close the sidebar menus on outside click
document.addEventListener('click', function(e) {
  const wrap = document.querySelector('.sidebar-menu-wrap');
  if (wrap && !wrap.contains(e.target)) closeSidebarMenu();
  const fwrap = document.getElementById('sidebar-filter-wrap');
  if (fwrap && !fwrap.contains(e.target)) closeFilterMenu();
});

// --- Sleep All ---
async function sleepAllSessions() {
  // Match on displayed status, not runningIds.  A session shown as idle via
  // guiOpenSessions or restart memory is absent from runningIds, so filtering
  // on runningIds silently skipped sessions the user could plainly see and had
  // just asked to sleep — they stayed alive on the daemon and came back as
  // idle on the next page refresh.  getSessionStatus() is the same source of
  // truth the sidebar icons use.
  const running = allSessions.filter(s => (typeof getSessionStatus === 'function')
    ? getSessionStatus(s.id) !== 'sleeping'
    : runningIds.has(s.id));
  if (!running.length) { showToast('No running sessions'); return; }
  const ok = await showConfirm('Sleep All Sessions', '<p>Close <strong>' + running.length + '</strong> running session' + (running.length > 1 ? 's' : '') + ' in this workspace?</p>', { danger: true, confirmText: 'Sleep All', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' });
  if (!ok) return;
  let closed = 0;
  for (const s of running) {
    // Explicit user sleep — block the live panel's ghost-recovery timers
    // from resurrecting any of these. See markUserStopped() in live-panel.js.
    if (typeof markUserStopped === 'function') markUserStopped(s.id);
    socket.emit('close_session', {session_id: s.id});
    runningIds.delete(s.id);
    delete sessionKinds[s.id];
    // Drop restart-memory too, or getSessionStatus() keeps reporting idle and
    // the session never falls back to 'sleeping'.
    if (window.sessionLastState) delete window.sessionLastState[s.id];
    closed++;
  }
  showToast(closed + ' session' + (closed !== 1 ? 's' : '') + ' closed');
  guiOpenSessions.clear();
  localStorage.setItem('guiOpenSessions', '[]');
  if (liveSessionId) {
    liveBarState = null;
    updateLiveInputBar();
  }
  filterSessions();
}

// --- Delete All ---
async function deleteAllSessions() {
  const count = allSessions.length;
  if (!count) { showToast('No sessions to delete'); return; }
  const ok = await showConfirm('Delete All Sessions', '<p>Permanently delete <strong>all ' + count + ' sessions</strong> in this workspace?</p><p>This cannot be undone.</p>', { danger: true, confirmText: 'Delete All', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' });
  if (!ok) return;
  // Double confirm for safety
  const ok2 = await showConfirm('Are you sure?', '<p>This will permanently delete <strong>' + count + ' sessions</strong> and all their history.</p>', { danger: true, confirmText: 'Yes, delete everything' });
  if (!ok2) return;
  showToast('Deleting ' + count + ' sessions…');
  if (liveSessionId) stopLivePanel();
  deselectSession();
  const _dap = localStorage.getItem('activeProject') || '';
  const _dapQ = _dap ? '?project=' + encodeURIComponent(_dap) : '';
  const resp = await fetch('/api/delete-all' + _dapQ, { method: 'DELETE' });
  const data = await resp.json();
  await loadSessions();
  loadProjects();                       // refresh splash-screen session counts
  showToast((data.deleted || count) + ' sessions deleted');
}

// --- Bulk Operations Modal ---
function openBulkOperations() {
  const overlay = document.getElementById('pm-overlay');

  // Gather counts for dynamic descriptions
  const hiddenCount = (typeof workspaceHiddenSessions !== 'undefined' && workspaceHiddenSessions) ? workspaceHiddenSessions.size : 0;
  const runningCount = allSessions.filter(s => runningIds.has(s.id)).length;
  const emptyCount = allSessions.filter(s => s.message_count === 0).length;
  const untitledCount = allSessions.filter(s => !s.custom_title && s.message_count > 0).length;
  const totalCount = allSessions.length;

  const operations = [
    {
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
      title: 'Unhide All Sessions',
      desc: hiddenCount > 0 ? hiddenCount + ' hidden session' + (hiddenCount !== 1 ? 's' : '') : 'No hidden sessions',
      disabled: hiddenCount === 0,
      danger: false,
      action: "wsShowAll();closeBulkOperations();showToast('All sessions unhidden')"
    },
    {
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
      title: 'Sleep All Sessions',
      desc: runningCount > 0 ? runningCount + ' running session' + (runningCount !== 1 ? 's' : '') : 'No running sessions',
      disabled: runningCount === 0,
      danger: false,
      action: "closeBulkOperations();sleepAllSessions()"
    },
    {
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
      title: 'Auto-name All Sessions',
      desc: untitledCount > 0 ? untitledCount + ' untitled session' + (untitledCount !== 1 ? 's' : '') : 'All sessions named',
      disabled: untitledCount === 0,
      danger: false,
      action: "closeBulkOperations();autoNameAllSessions()"
    },
    {
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
      title: 'Delete Empty Sessions',
      desc: emptyCount > 0 ? emptyCount + ' empty session' + (emptyCount !== 1 ? 's' : '') : 'No empty sessions',
      disabled: emptyCount === 0,
      danger: true,
      action: "closeBulkOperations();deleteEmptySessions()"
    },
    {
      icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      title: 'Delete All Sessions',
      desc: totalCount > 0 ? totalCount + ' session' + (totalCount !== 1 ? 's' : '') + ' in workspace' : 'No sessions',
      disabled: totalCount === 0,
      danger: true,
      action: "closeBulkOperations();deleteAllSessions()"
    },
  ];

  var html = '<div class="pm-card pm-enter" style="width:480px;max-width:92vw;">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
  html += '<h2 class="pm-title" style="margin:0;">Bulk Operations</h2>';
  html += '<button class="pm-btn pm-btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="closeBulkOperations()">&times;</button>';
  html += '</div>';
  html += '<div class="pm-body"><p>Perform actions across all sessions in this workspace.</p></div>';
  html += '<div class="bulk-ops-list">';

  for (var i = 0; i < operations.length; i++) {
    var op = operations[i];
    html += '<div class="bulk-ops-item' + (op.disabled ? ' disabled' : '') + '">';
    html += '<div class="bulk-ops-icon' + (op.danger ? ' danger' : '') + '">' + op.icon + '</div>';
    html += '<div class="bulk-ops-info">';
    html += '<div class="bulk-ops-title">' + op.title + '</div>';
    html += '<div class="bulk-ops-desc">' + op.desc + '</div>';
    html += '</div>';
    html += '<button class="pm-btn ' + (op.danger ? 'pm-btn-danger' : 'pm-btn-secondary') + ' bulk-ops-btn" '
          + (op.disabled ? 'disabled ' : '')
          + 'onclick="' + op.action + '">Run</button>';
    html += '</div>';
  }

  html += '</div></div>';

  overlay.innerHTML = html;
  overlay.classList.add('show');
  requestAnimationFrame(function() {
    var card = overlay.querySelector('.pm-card');
    if (card) card.classList.remove('pm-enter');
  });
}

function closeBulkOperations() {
  _closePm();
}

// --- Auto-name All Sessions ---
async function autoNameAllSessions() {
  const untitled = allSessions.filter(s => !s.custom_title && s.message_count > 0);
  if (!untitled.length) { showToast('All sessions already named'); return; }

  const ok = await showConfirm(
    'Auto-name All Sessions',
    '<p>Auto-name <strong>' + untitled.length + '</strong> untitled session' + (untitled.length !== 1 ? 's' : '') + '?</p>'
    + '<p>This uses AI to generate meaningful names based on each session\u2019s content. Sessions with user-set names will be skipped.</p>',
    {
      confirmText: 'Name All',
      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'
    }
  );
  if (!ok) return;

  showToast('Naming ' + untitled.length + ' session' + (untitled.length !== 1 ? 's' : '') + '\u2026');
  let named = 0;
  for (const s of untitled) {
    try {
      const resp = await fetch('/api/autonname/' + s.id, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({project: localStorage.getItem('activeProject') || ''}) });
      const data = await resp.json();
      if (data.ok && data.title) {
        s.custom_title = data.title;
        s.display_title = data.title;
        named++;
      }
    } catch(e) { /* skip failures silently */ }
  }
  filterSessions();
  // Update toolbar if the active session was renamed
  if (activeId) {
    const active = allSessions.find(x => x.id === activeId);
    if (active && active.custom_title) {
      setToolbarSession(activeId, active.custom_title, false, active.custom_title);
    }
  }
  showToast('Named ' + named + ' session' + (named !== 1 ? 's' : ''));
}

// Mobile: bring a programmatically-focused composer above the on-screen
// keyboard. A user tap gets this for free from the browser; a JS .focus() does
// not — the native reveal is deferred to the first keystroke. We wait for the
// keyboard to actually open (visualViewport 'resize' fires when it does) and
// then scroll the field into view. scrollIntoView is gesture-safe and won't
// re-open/close the keyboard, so it doesn't break the synchronous-focus chain
// the caller relies on to raise the keyboard in the first place.
function _revealComposerAboveKeyboard(el) {
  if (!el) return;
  const doScroll = () => { try { el.scrollIntoView({ block: 'center' }); } catch (e) {} };
  const vv = window.visualViewport;
  if (!vv) { setTimeout(doScroll, 350); return; }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    vv.removeEventListener('resize', onResize);
    doScroll();
  };
  const onResize = finish;
  vv.addEventListener('resize', onResize);
  // Fallback: if the keyboard was already open (no resize fires) or the event
  // never lands, reveal after the typical keyboard-open animation window.
  setTimeout(finish, 350);
}

/** Scroll the sidebar so this session's card or row is visible (no-op when
 *  it is already, or not drawn).  Only the sidebar scrolls, never the page. */
function _scrollSessionCardIntoView(sid) {
  const el = document.querySelector('#workforce-grid .wf-card[data-sid="' + sid + '"], #session-list .session-item[data-sid="' + sid + '"]');
  if (!el) return;
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_e) { /* old browser: harmless */ }
}

/** A new session made in this tab whose first message has not been sent:
 *  it exists only in this page, so nothing the server reports about running
 *  sessions applies to it (otherwise a state refresh forgets it and
 *  clicking away and back shows "Session not found"). */
function _isUnsentNewSession(sid) {
  const row = (typeof SessionStore !== 'undefined' && SessionStore.get) ? SessionStore.get(sid) : null;
  return !!(row && row.unsent);
}

// --- New Agent ---
async function addNewAgent() {
  // All projects view: ask which project first (all-projects.js).
  let _apProject = '';
  if (window.VNAllProjects && VNAllProjects.on()) {
    _apProject = await VNAllProjects.beforeNewSession();
    if (!_apProject) return;
  }
  // If on homepage, switch to sessions mode first
  if (viewMode === 'homepage') setViewMode('sessions');

  const newId = crypto.randomUUID();
  // Build the agent list while the person types: Send waits on it, and on a
  // large project it took seconds with nothing on screen.
  if (typeof FOLDER_SUPERSET === 'object' && FOLDER_SUPERSET) _ensureAgentCatalog();

  // Leaving the open session: keep what was typed there (same as openInGUI).
  if (liveSessionId && liveSessionId !== newId) { _savePendingInputAsDraft(); stopLivePanel(); }

  // Optimistic UI: add placeholder to sidebar.  It is stamped "now" (as the
  // session_started stub is) so it sorts first by date: with no time it would
  // sink to the bottom of the list until the server reloaded it.
  const _nowS = Date.now() / 1000;
  const optimistic = {
    id: newId,
    display_title: 'New Session',
    custom_title: '',
    last_activity: '',
    last_activity_ts: _nowS,
    sort_ts: _nowS,
    effective_ts: _nowS,
    size: '',
    message_count: 0,
    preview: '',
    // Made in this tab, nothing sent yet: the server has no record of it, so
    // the "not running any more" clean-ups and list reloads must keep it.
    // Cleared by _newSessionSubmit.  See _isUnsentNewSession.
    unsent: true,
  };
  if (_apProject && _apProject !== true) optimistic._project = _apProject;
  SessionStore.set(newId, optimistic);   // new id: inserted at the front, list + id Set

  // Mark as GUI-opened but DON'T add to runningIds or sessionKinds yet.
  // The session doesn't exist on the server until _newSessionSubmit sends it.
  guiOpenAdd(newId);

  // In workplace mode, expand the card
  if (workspaceActive) {
    // Set workspace expanded state but DON'T call expandWorkspaceCard
    // (it would start the live panel before the user has typed anything)
    _wsExpandedId = newId;
    activeId = newId;
    localStorage.setItem('activeSessionId', newId);
    document.getElementById('main-toolbar').style.display = '';
    setToolbarSession(newId, 'New Session', true, '');
    _addWorkspaceBackBtn();
  } else {
    if (typeof _ensureMainBodyVisible === 'function') _ensureMainBodyVisible();
    activeId = newId;
    localStorage.setItem('activeSessionId', newId);
    setToolbarSession(newId, 'New Session', true, '');
  }

  // Draw the sidebar only now that the new session is the open one, so its
  // card is highlighted in the same frame it appears (it used to be drawn
  // first and stay unhighlighted until some later redraw), and bring it
  // into view.
  filterSessions();
  _scrollSessionCardIntoView(newId);

  // Update URL/history so back/forward and reload work the same as clicking a session
  _pushChatUrl(newId);

  // Register session in current folder if in workplace hierarchy
  if (workspaceActive && typeof addSessionToFolder === 'function' && typeof _currentFolderId !== 'undefined' && _currentFolderId) {
    addSessionToFolder(newId, _currentFolderId);
  }

  // Show empty chat with focused input — no dialog, no spinner
  document.getElementById('main-body').innerHTML =
    '<div class="live-panel" id="live-panel">' +
    '<div class="conversation live-log" id="live-log">' +
    '<div class="empty-state" style="padding:60px 0;text-align:center;">' +
    '<svg class="vibenode-mark dn-mark" width="30" height="24" viewBox="0 0 181 142" aria-hidden="true"><path d="M0 0h36.5l70 71-70 71H0l70-71z"/><circle cx="154.5" cy="116" r="26"/></svg>' +
    '<div class="vibenode-greeting">What are we building today?</div>' +
    (typeof _renderTemplateGrid === 'function' ? _renderTemplateGrid(newId) : '') +
    (typeof _newSessionCancelHtml === 'function' ? _newSessionCancelHtml() : '') +
    '</div></div>' +
    '<div class="live-input-bar" id="live-input-bar"></div></div>';
  // All projects: the project picker stayed up, showing the pick, until now.
  if (_apProject) _closeChoiceOverlay();

  // Show idle input bar immediately — user types their first message here
  liveSessionId = newId;
  liveLineCount = 0;
  liveBarState = null;
  _optimisticMsgId = 0;
  // This path builds the live panel inline instead of going through
  // startLivePanel(), so bind the scroll/collapse state machine here too —
  // otherwise a brand-new session's thread has no scroll state at all.
  // ThreadScroll.attach() also resets liveAutoScroll to true.
  if (window.ThreadScroll) ThreadScroll.attach(document.getElementById('live-log'), newId);
  else liveAutoScroll = true;

  const bar = document.getElementById('live-input-bar');
  if (bar) {
    bar.innerHTML =
      '<textarea id="live-input-ta" class="live-textarea" rows="3" placeholder="Describe what you want Claude to do\u2026" autofocus' +
      ' onkeydown="if(_shouldSend(event)){event.preventDefault();_newSessionSubmit(\'' + newId + '\')}"' +
      ' onblur="if(_wasKeyboardDismissBlur()){_newSessionSubmit(\'' + newId + '\')}">' +
      '</textarea>' +
      '<div class="live-bar-row">' +
      (typeof _buildBarLeftGroup === 'function' ? _buildBarLeftGroup('', true, '', newId) : '<div class="bar-left-group"></div>') +
      '<span class="send-hint" style="font-size:10px;color:var(--text-faint);">' + _sendHint() + '</span>' +
      '<button class="live-send-btn" id="live-voice-btn"></button>' +
      '</div>';
    setupVoiceButton(document.getElementById('live-input-ta'), document.getElementById('live-voice-btn'), () => _newSessionSubmit(newId));
    // Focus SYNCHRONOUSLY — a setTimeout here breaks the user-gesture chain on
    // mobile browsers, so the on-screen keyboard doesn't come up. We still run
    // the non-critical listener registration in a setTimeout below to keep the
    // desktop timing identical to before.
    const _taSync = document.getElementById('live-input-ta');
    if (_taSync) {
      _taSync.focus();
      // Mobile: a *programmatic* .focus() opens the on-screen keyboard but —
      // unlike a real user tap — does NOT trigger the browser's native "scroll
      // the focused field above the keyboard" pass. That native reveal only
      // fires on the first keystroke, which is exactly the "doesn't shift into
      // view until I start typing" bug. Reproduce the reveal ourselves once the
      // keyboard has actually opened. (A bare post-focus scrollIntoView here is
      // useless: at focus time the keyboard isn't up yet, so there's nothing to
      // scroll past — the scroll target only exists after the viewport resizes.)
      _revealComposerAboveKeyboard(_taSync);
    }
    setTimeout(() => {
      const ta = document.getElementById('live-input-ta');
      if (ta) {
        ta.focus();   // desktop retry — harmless if the sync focus already stuck
        ta.addEventListener('input', function() { if (typeof _hideTemplateGrid === 'function') _hideTemplateGrid(); });
      }
    }, 50);
  }
}

// ---------------------------------------------------------------------------
// Agent catalog — write all definitions to a temp file, system prompt gets
// just a single-line pointer.  Keeps the CLI argument short.
// ---------------------------------------------------------------------------

let _agentCatalogPath = null;
let _agentCatalogPromise = null;

/**
 * POST all agent definitions to the backend which writes them to a temp
 * file.  Returns the absolute file path (cached after first call).
 */
async function _ensureAgentCatalog() {
  if (_agentCatalogPath) return _agentCatalogPath;
  if (_agentCatalogPromise) return _agentCatalogPromise;

  _agentCatalogPromise = (async () => {
    try {
      if (typeof FOLDER_SUPERSET !== 'object' || !FOLDER_SUPERSET) return null;

      const agents = Object.entries(FOLDER_SUPERSET)
        .filter(([, def]) => def.skill && def.skill.systemPrompt)
        .map(([id, def]) => ({
          id,
          label: def.skill.label || def.name,
          systemPrompt: def.skill.systemPrompt,
        }));

      // Include local project skills and agents in the catalog
      if (typeof _fetchLocalWorkforce === 'function') {
        try {
          const local = await _fetchLocalWorkforce();
          for (const sk of (local.skills || [])) {
            agents.push({ id: 'local-skill-' + sk.id, label: '[Local Skill] ' + (sk.name || sk.id), systemPrompt: sk.systemPrompt || '' });
          }
          for (const ag of (local.agents || [])) {
            agents.push({ id: 'local-agent-' + ag.id, label: '[Local Agent] ' + (ag.name || ag.id), systemPrompt: ag.systemPrompt || '' });
          }
        } catch (_) { /* non-fatal */ }
      }

      if (!agents.length) return null;

      const resp = await fetch('/api/agents/write-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents }),
      });
      const data = await resp.json();
      if (data.ok && data.path) {
        _agentCatalogPath = data.path;
        return _agentCatalogPath;
      }
    } catch (e) {
      console.warn('Failed to write agent catalog:', e);
    }
    return null;
  })();

  return _agentCatalogPromise;
}

/**
 * Returns a single-line system prompt pointer to the agent catalog file.
 */
function _buildAgentDefinitions() {
  if (!_agentCatalogPath) return '';
  return 'You have specialist agents available. Read the agent catalog file at ' +
    _agentCatalogPath + ' for the full list, instructions, and system prompts. ' +
    'You MUST read that file before spawning any agent.';
}

async function _newSessionSubmit(sessionId) {
  const ta = document.getElementById('live-input-ta');
  if (!ta) return;
  let text = ta.value.trim();
  if (!text && !window._pendingInvoke) { showToast('Type a message first'); return; }
  if (typeof _interceptSlashCommand === 'function' && _interceptSlashCommand(text)) {
    ta.value = ''; _resetTextareaHeight(ta); return;
  }
  ta.value = '';  // clear immediately to prevent double-submit on key repeat
  _resetTextareaHeight(ta);
  if (typeof _defocusComposerMobile === 'function') _defocusComposerMobile();
  if (typeof _clearDraft === 'function') _clearDraft(sessionId);

  // Wrap with invoke if pending
  const _hasInvoke = !!window._pendingInvoke;
  const _invokeNotice = (window._pendingInvoke && typeof _buildInvokeNotice === 'function') ? _buildInvokeNotice() : '';
  if (window._pendingInvoke && typeof _wrapInvokeMessage === 'function') {
    text = _wrapInvokeMessage(text || '');
  }

  // NOW seed as running (session will exist on server after this emit)
  runningIds.add(sessionId);
  sessionKinds[sessionId] = 'working';

  // Draw the chat and the message the moment Send is pressed. The start below
  // waits on the agent list (a scan of the project that took seconds on a
  // large one); drawing after it left an empty box and the greeting on screen,
  // so the message looked lost. Its footer says Sending until the server
  // takes it.
  if (liveSessionId === sessionId) {
    _optimisticMsgId = 0;
    startLivePanel(sessionId, {skipLog: true});
    _liveSending = true;
    const _pend = (typeof _notePendingSend === 'function') ? _notePendingSend(sessionId, text, false) : null;
    _addOptimisticBubble(sessionId, text, false, _pend ? {pending: _pend} : undefined);
    setTimeout(() => { _liveSending = false; }, 500);
  }
  // Which session is on screen as this starts.  The awaits below can take a
  // moment; if the person opens another session meanwhile, the session still
  // starts, but this must not pull the screen back to it.
  const _liveAtSubmit = liveSessionId;
  const _sentRow = SessionStore.get(sessionId);
  if (_sentRow) delete _sentRow.unsent;   // the server knows it from here on
  // The sidebar row turns Working at Send too, not after the agent list
  // below is ready (seconds on a large project) or the server's first state.
  if (typeof _updateRowState === 'function') _updateRowState(sessionId, 'working');

  // Get skill from current folder (if in workplace mode with folder tree)
  let systemPrompt = null;
  if (workspaceActive && typeof _currentFolderId !== 'undefined' && _currentFolderId) {
    const skill = (typeof getFolderSkill === 'function') ? getFolderSkill(_currentFolderId) : null;
    if (skill && skill.systemPrompt) systemPrompt = skill.systemPrompt;
  }

  // Layer in template system prompt if a template was selected
  if (window._pendingTemplateSystemPrompt) {
    systemPrompt = systemPrompt
      ? systemPrompt + '\n\n' + window._pendingTemplateSystemPrompt
      : window._pendingTemplateSystemPrompt;
    window._pendingTemplateSystemPrompt = null;
  }

  // Ensure agent catalog temp file is written, then inject compact index
  // Skip for compose sessions — their prompt is built entirely server-side
  const _isCompose = viewMode === 'compose' && typeof composeDetailTaskId !== 'undefined' && composeDetailTaskId;
  if (!_isCompose && typeof FOLDER_SUPERSET === 'object' && FOLDER_SUPERSET) {
    await _ensureAgentCatalog();
    const agentBlock = _buildAgentDefinitions();
    if (agentBlock) {
      systemPrompt = systemPrompt
        ? systemPrompt + '\n\n' + agentBlock
        : agentBlock;
    }
  }

  // Copy cards: long copyable texts go to a file and a ```copyfile block.
  if (!_isCompose && typeof _buildCopyExportNote === 'function') {
    const copyNote = _buildCopyExportNote();
    systemPrompt = systemPrompt ? systemPrompt + '\n\n' + copyNote : copyNote;
  }

  // Inject invoke skill notice into system prompt
  if (_invokeNotice) {
    systemPrompt = systemPrompt
      ? systemPrompt + _invokeNotice
      : _invokeNotice.trim();
  }

  // Resolve model/thinking from the single owner (SessionModel): this pending
  // session's chosen model, else the system default.  There is no global
  // override, so the choice can never leak in from another session.
  const _modelToUse = (typeof SessionModel !== 'undefined')
    ? SessionModel.effectivePending(sessionId)
    : ((typeof defaultModel !== 'undefined') ? defaultModel : '');
  const _thinkingToUse = (typeof SessionModel !== 'undefined')
    ? SessionModel.getDesiredThinking(sessionId)
    : ((typeof defaultThinking !== 'undefined') ? defaultThinking : '');

  const startOpts = {
    session_id: sessionId,
    prompt: text,
    cwd: _currentProjectDir(),
    name: '',
  };
  if (_modelToUse) startOpts.model = _modelToUse;
  if (_thinkingToUse) startOpts.thinking_level = _thinkingToUse;
  if (systemPrompt) startOpts.system_prompt = systemPrompt;

  // Clear per-session overrides now that the session is being dispatched.
  if (typeof _clearSessionModelOverride === 'function') _clearSessionModelOverride();

  // Auto-detect compose task context — inject compose_task_id so the
  // backend can resolve and inject the compose system prompt automatically.
  if (viewMode === 'compose' && typeof composeDetailTaskId !== 'undefined' && composeDetailTaskId) {
    startOpts.compose_task_id = composeDetailTaskId;
  }

  socket.emit('start_session', startOpts);
  const _stillHere = liveSessionId === _liveAtSubmit;

  // Use the user's first message as a placeholder title until auto-name kicks in,
  // BUT respect any name the user already set — don't overwrite it.
  const s = allSessions.find(x => x.id === sessionId);
  if (s && s.custom_title && _userNamedSessions.has(sessionId)) {
    // User already named this session — keep their title
    if (_stillHere) setToolbarSession(sessionId, s.custom_title, false, s.custom_title);
  } else {
    let _placeholder;
    if (/\[\[invoke\]\]/.test(text)) {
      _placeholder = 'Invoke Workforce';
    } else {
      _placeholder = text.split('\n')[0].slice(0, 65) + (text.length > 65 ? '\u2026' : '');
    }
    if (s) { s.display_title = _placeholder; }
    if (_stillHere) setToolbarSession(sessionId, _placeholder, true, '');
  }
  filterSessions();

  // Register session in current folder
  if (workspaceActive && typeof addSessionToFolder === 'function') {
    addSessionToFolder(sessionId, _currentFolderId);
  }

  // Switch to live panel mode — skip log fetch since this is a brand-new session
  // Clear dedup set right before panel creation so stale entries from
  // any prior session during the async await cannot block the bubble.
  // Not when the person has moved to another session meanwhile: opening this
  // one again fetches its log, first message included.
  // The chat and the message were drawn at Send (above). Only a session that
  // was not on screen then (started from elsewhere) is drawn now.
  if (_stillHere && _liveAtSubmit !== sessionId) {
    _optimisticMsgId = 0;
    startLivePanel(sessionId, {skipLog: true});
    _liveSending = true;
    _addOptimisticBubble(sessionId, text);
    setTimeout(() => { _liveSending = false; }, 500);
  }

  // Auto-name immediately using the prompt text (no need to wait for JSONL)
  if (!_userNamedSessions.has(sessionId)) autoName(sessionId, true, false, text);
}

// _showNewSessionDialog removed — addNewAgent now goes straight to chat

// --- Keyboard Navigation ---
document.addEventListener('keydown', (e) => {
  // Never block browser shortcuts (refresh, dev tools, etc)
  if (e.ctrlKey || e.metaKey) return;
  // Don't intercept when typing in inputs
  if (e.target.matches('input, textarea, select, [contenteditable]')) return;
  // Don't intercept if a modal is open
  if (document.getElementById('pm-overlay').classList.contains('show')) return;

  if (e.key === 'n' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    addNewAgent();
  } else if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    _selectAdjacentSession(1);
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    _selectAdjacentSession(-1);
  } else if (e.key === 'Enter') {
    if (activeId && !liveSessionId) {
      e.preventDefault();
      startLivePanel(activeId);
    }
  } else if (e.key === 'Escape') {
    if (liveSessionId) {
      e.preventDefault();
      stopLivePanel();
    }
  } else if (e.key === '?' && e.shiftKey) {
    e.preventDefault();
    _showHelpModal();
  }
});

function _selectAdjacentSession(direction) {
  // Try list view items first, then workforce cards
  let items = Array.from(document.querySelectorAll('.session-item[data-sid]'));
  if (!items.length) {
    // Workforce grid: cards have onclick with session IDs but no data-sid;
    // use the sidebar session list if available, otherwise bail
    return;
  }
  const idx = items.findIndex(el => el.dataset.sid === activeId);
  const next = items[Math.max(0, Math.min(items.length - 1, idx + direction))];
  if (next) selectSession(next.dataset.sid);
}

// --- Help Modal ---
function _showHelpModal() {
  const overlay = document.getElementById('pm-overlay');
  overlay.innerHTML = `
    <div class="pm-card pm-enter" style="width:460px;">
      <h2 class="pm-title">Keyboard Shortcuts</h2>
      <div class="pm-body" style="margin-bottom:0;">
        <table class="help-table">
          <tr><td><kbd>N</kbd></td><td>New session</td></tr>
          <tr><td><kbd>\u2191</kbd> / <kbd>K</kbd></td><td>Previous session</td></tr>
          <tr><td><kbd>\u2193</kbd> / <kbd>J</kbd></td><td>Next session</td></tr>
          <tr><td><kbd>Enter</kbd></td><td>Open live panel</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close panel / Interrupt</td></tr>
          <tr><td><kbd>${_MOD}+F</kbd></td><td>Find in session</td></tr>
          <tr><td><kbd>${_MOD}+Enter</kbd></td><td>Send message</td></tr>
          <tr><td><kbd>?</kbd></td><td>This help</td></tr>
        </table>
      </div>
      <div class="pm-actions" style="margin-top:16px;">
        <button class="pm-btn pm-btn-primary" id="pm-ok">Close</button>
      </div>
    </div>`;
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.querySelector('.pm-card').classList.remove('pm-enter'));
  const close = () => { _closePm(); };
  document.getElementById('pm-ok').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };
  document.getElementById('pm-ok').focus();
}

// --- CLAUDE.md Memory Editor ---
async function _showMemoryEditor() {
  const overlay = document.getElementById('pm-overlay');
  overlay.innerHTML = `
    <div class="pm-card pm-enter" style="width:580px;max-height:85vh;display:flex;flex-direction:column;">
      <h2 class="pm-title">CLAUDE.md Editor</h2>
      <div style="display:flex;flex-direction:column;flex:1;min-height:0;gap:12px;">
        <div class="memory-tabs">
          <button class="mem-tab active" id="mem-tab-project">Project</button>
          <button class="mem-tab" id="mem-tab-global">Global</button>
        </div>
        <div id="mem-project" style="display:flex;flex-direction:column;flex:1;min-height:0;">
          <p class="mem-path" id="mem-project-path" style="font-size:10px;color:var(--text-faint);margin-bottom:6px;">Loading...</p>
          <textarea class="ns-textarea" id="mem-project-content" rows="16" placeholder="Project CLAUDE.md content…" style="flex:1;min-height:200px;"></textarea>
        </div>
        <div id="mem-global" style="display:none;flex-direction:column;flex:1;min-height:0;">
          <p class="mem-path" id="mem-global-path" style="font-size:10px;color:var(--text-faint);margin-bottom:6px;">~/.claude/CLAUDE.md</p>
          <textarea class="ns-textarea" id="mem-global-content" rows="16" placeholder="Global CLAUDE.md content…" style="flex:1;min-height:200px;"></textarea>
        </div>
      </div>
      <div class="pm-actions" style="margin-top:14px;">
        <button class="pm-btn pm-btn-secondary" id="mem-cancel">Cancel</button>
        <button class="pm-btn pm-btn-primary" id="mem-save">Save</button>
      </div>
    </div>`;
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.querySelector('.pm-card').classList.remove('pm-enter'));

  // Tab switching
  const tabProject = document.getElementById('mem-tab-project');
  const tabGlobal = document.getElementById('mem-tab-global');
  const panelProject = document.getElementById('mem-project');
  const panelGlobal = document.getElementById('mem-global');
  tabProject.onclick = () => {
    tabProject.classList.add('active'); tabGlobal.classList.remove('active');
    panelProject.style.display = 'flex'; panelGlobal.style.display = 'none';
  };
  tabGlobal.onclick = () => {
    tabGlobal.classList.add('active'); tabProject.classList.remove('active');
    panelGlobal.style.display = 'flex'; panelProject.style.display = 'none';
  };

  // Load content
  try {
    const [projRes, globalRes] = await Promise.all([
      fetch('/api/claude-md').then(r => r.json()).catch(() => ({content:'', path:'Not found'})),
      fetch('/api/claude-md-global').then(r => r.json()).catch(() => ({content:'', path:'~/.claude/CLAUDE.md'})),
    ]);
    document.getElementById('mem-project-path').textContent = projRes.path || 'Not found';
    document.getElementById('mem-project-content').value = projRes.content || '';
    document.getElementById('mem-global-path').textContent = globalRes.path || '~/.claude/CLAUDE.md';
    document.getElementById('mem-global-content').value = globalRes.content || '';
  } catch(e) {
    showToast('Failed to load CLAUDE.md files', true);
  }

  const close = () => { _closePm(); };
  document.getElementById('mem-cancel').onclick = close;
  overlay.onclick = e => { if (e.target === overlay) close(); };

  document.getElementById('mem-save').onclick = async () => {
    try {
      const results = await Promise.all([
        fetch('/api/claude-md', {
          method: 'PUT', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({content: document.getElementById('mem-project-content').value})
        }).then(r => r.json()).catch(() => ({ok:false})),
        fetch('/api/claude-md-global', {
          method: 'PUT', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({content: document.getElementById('mem-global-content').value})
        }).then(r => r.json()).catch(() => ({ok:false})),
      ]);
      close();
      showToast('CLAUDE.md files saved');
    } catch(e) {
      showToast('Failed to save', true);
    }
  };
}

// --- Skeleton & Sessions ---
function showSkeletonLoader() {
  const el = document.getElementById('session-list');
  let html = '';
  // Cards view: card-shaped placeholders, so the loading state matches what
  // is about to appear.  Same markup as the inline first-paint skeleton in index.html.
  if (sessionDisplayMode === 'grid') {
    html = '<div class="skel-cards">';
    for (let c = 0; c < 8; c++) {
      const cd = (c * 0.06).toFixed(2);
      html += '<div class="skel-card">' + ['ico', 'pill', 't1', 't2', 'meta'].map(k =>
        '<div class="skel-bar ' + k + '" style="animation-delay:' + cd + 's"></div>').join('') + '</div>';
    }
    el.innerHTML = html + '</div>';
    return;
  }
  for (let i = 0; i < 20; i++) {
    const nw = 40 + Math.random() * 45;
    const delay = (i * 0.06).toFixed(2);
    html += '<div class="skel-row">'
      + '<div><div class="skel-bar name" style="width:' + nw + '%;animation-delay:' + delay + 's"></div></div>'
      + '<div><div class="skel-bar date" style="animation-delay:' + delay + 's"></div></div>'
      + '<div><div class="skel-bar size" style="animation-delay:' + delay + 's"></div></div>'
      + '</div>';
  }
  el.innerHTML = html;
}

let _loadSessionsAbort = null;

async function loadSessions() {
  showSkeletonLoader();
  // Abort any in-flight loadSessions fetch to prevent stale project data
  if (_loadSessionsAbort) _loadSessionsAbort.abort();
  _loadSessionsAbort = new AbortController();
  const _myAbort = _loadSessionsAbort;
  const _myGen = _projectSwitchGen;  // capture generation at call time

  // Load workforce assets from disk first (replaces FOLDER_SUPERSET before folder tree reads it)
  // Then load sessions and folder tree in parallel
  if (typeof _loadWorkforceFromDisk === 'function') {
    try { await _loadWorkforceFromDisk(); } catch(e) {}
  }
  // If project switched during workforce load, bail
  if (_myGen !== _projectSwitchGen) { console.warn('[loadSessions] project switched during workforce load — discarding'); return; }
  // Pass activeProject so the server syncs _active_project before processing.
  // Closes the race where this HTTP fetch arrives before the WebSocket
  // reconnects and sends request_state_snapshot with the project context.
  // All projects view (all-projects.js): every project's sessions, tagged with
  // their project.  The stale check compares the view, not activeProject,
  // which moves to the project of whatever session is opened.
  const _allView = !!(window.VNAllProjects && VNAllProjects.on());
  const _projParam = _allView ? VNAllProjects.ALL : (localStorage.getItem('activeProject') || '');
  const _sessUrl = (_projParam && !_allView) ? '/api/sessions?project=' + encodeURIComponent(_projParam) : '/api/sessions';
  // Resilient sessions fetch — same reason as loadProjects(): after the mobile
  // reviver hands off to a freshly-booting server, /api/sessions can transiently
  // fail before the daemon is ready. Retry until it answers (or the project
  // switches, which aborts _myAbort and breaks the loop) so the skeleton always
  // resolves instead of hanging forever.
  async function _fetchSessions() {
    if (_allView) {
      try { return await VNAllProjects.fetchAll(_myAbort.signal); }
      catch (e) { if (_myAbort.signal.aborted) throw e; }
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      if (_myAbort.signal.aborted || _myGen !== _projectSwitchGen) break;
      try {
        const r = await fetch(_sessUrl, { signal: _myAbort.signal, cache: 'no-store' });
        if (r.ok) return r;
      } catch (e) {
        if (_myAbort.signal.aborted) throw e;   // real cancellation — propagate
        /* server mid-boot — retry below */
      }
      await new Promise(r => setTimeout(r, 750));
    }
    // Aborted/superseded — return a benign empty response so downstream guards
    // (the _myGen / _nowProj checks below) discard it cleanly.
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  const [resp] = await Promise.all([
    _fetchSessions(),
    (typeof initFolderTree === 'function') ? initFolderTree().catch(function(){}) : Promise.resolve(),
  ]);
  // Guard: if project changed while we were fetching, discard stale response
  if (_myGen !== _projectSwitchGen) { console.warn('[loadSessions] project switched during fetch — discarding'); return; }
  const _nowProj = (window.VNAllProjects && VNAllProjects.on()) ? VNAllProjects.ALL : (localStorage.getItem('activeProject') || '');
  if (_nowProj !== _projParam) { console.warn('[loadSessions] stale response for', _projParam, '— discarding'); return; }
  const _freshSessions = await resp.json();
  // Preserve optimistic entries for sessions the user is actively working in
  // (e.g. just-started session whose JSONL hasn't been created yet).
  // Without this, a concurrent loadSessions() from setProject() wipes the
  // optimistic entry and destroys the live panel.
  const _freshIds = new Set(_freshSessions.map(s => s.id));
  // Also keep a new session made in this tab that the server has no file
  // for yet, even when another session is open: a reload (a reconnect, a
  // duplicate) would otherwise drop its card, leaving nothing to click back to.
  const _preserved = allSessions.filter(s =>
      !_freshIds.has(s.id) && (s.id === liveSessionId
        || s.unsent)
  );
  // One bulk replace.  SessionStore.replaceAll() also dedups by id (first copy
  // wins): the race between remap events and the session list fetch can
  // produce two entries with the same ID.
  const _remaps = window._idRemaps || {};
  SessionStore.replaceAll(_preserved.concat(_freshSessions).filter(s =>
    // Hidden utility sessions (planner, auto-title, etc.): any session ID
    // starting with "_" is a system/utility session.
    !s.id.startsWith('_') &&
    !(s.session_type && (s.session_type === 'planner' || s.session_type === 'title')) &&
    // Stale alias entries (old pre-remap IDs still on disk or in daemon).
    !_remaps[s.id]
  ));
  _rebuildSessionIds();   // multi-selection prune
  // A reload computed before a title was saved must not wipe a title this
  // page already received (see _knownSessionTitles).  Fills nameless rows only.
  if (_knownSessionTitles.size) {
    for (const s of allSessions) _applyKnownSessionTitle(s);
  }
  // Populate _userNamedSessions from server so manual names survive page refresh
  if (typeof _userNamedSessions !== 'undefined') {
    for (const s of allSessions) {
      if (s.user_named) _userNamedSessions.add(s.id);
    }
  }
  // Restore-across-restart: /api/sessions tags sessions that were idle/working
  // before the last restart (but aren't live now) with `last_state`. Seed a
  // lookup map so getSessionStatus() can show them as idle/working instead of
  // "sleeping". Rebuilt from scratch each load; live state always overrides it.
  window.sessionLastState = {};
  for (const s of allSessions) {
    if (s.last_state === 'working' || s.last_state === 'idle') {
      window.sessionLastState[s.id] = s.last_state;
    }
  }
  document.getElementById('search').placeholder = 'Search ' + allSessions.length + ' sessions\u2026';
  _refreshUntitledButton();   // fire-and-forget; hides itself on any failure
  setViewMode(viewMode);
  // Template selector is handled by initFolderTree() — no duplicate call here

  // Re-apply session state CSS classes to the freshly rendered DOM rows.
  // setViewMode() just rebuilt the sidebar/grid from allSessions, but the
  // state_snapshot may have already populated sessionKinds before this
  // render.  Without this, sessions show as "sleeping" until the next
  // individual session_state event arrives.
  if (typeof _updateRowState === 'function') {
    for (const id in sessionKinds) {
      const kind = sessionKinds[id];
      const state = kind === 'question' ? 'waiting' : kind;
      _updateRowState(id, state);
    }
  }

  // Homepage: no session restoration needed, homepage is fully rendered by setViewMode
  if (viewMode === 'homepage') return;

  // Check URL ?chat= param first, then fall back to localStorage
  const _urlChatId = new URL(window.location).searchParams.get('chat');

  // In workplace mode, the workspace canvas is already rendered by setViewMode->filterSessions.
  if (viewMode === 'workplace') {
    if (_urlChatId && allSessions.find(s => s.id === _urlChatId)) {
      _skipChatHistory = true;
      expandWorkspaceCard(_urlChatId);
      _skipChatHistory = false;
    } else {
      activeId = null;
      localStorage.removeItem('activeSessionId');
    }
    return;
  }
  // If the user already has an active live panel (e.g. they started a new
  // session while this async loadSessions was still in flight), don't clobber
  // it with session restoration or the dashboard.
  if (liveSessionId && document.getElementById('live-panel')) {
    filterSessions();
    return;
  }

  // Restore session from URL, then localStorage, then per-project memory, or show dashboard.
  // Skip session restore entirely when the URL hash points to a kanban or compose view —
  // restoreFromHash handles navigation there; restoring a stale activeSessionId
  // would hijack the view and open a session from a different task/subtree.
  // Also skip during project switches — the user wants to stay in the current
  // view at its base state (no session selected).
  const _hashIsKanban = window.location.hash.startsWith('#kanban');
  const _hashIsCompose = window.location.hash.startsWith('#compose');
  const _skipRestore = _suppressSessionRestore;
  _suppressSessionRestore = false;
  const _activeProj = localStorage.getItem('activeProject');
  let _restoreId = (_hashIsKanban || _hashIsCompose || _skipRestore) ? null : (
    _urlChatId || localStorage.getItem('activeSessionId')
    || (_activeProj && localStorage.getItem('projectSession_' + _activeProj))
  );

  // If the stored ID isn't in allSessions, it may have been remapped by the SDK.
  // Ask the server to resolve the alias before giving up.
  if (_restoreId && !allSessions.find(s => s.id === _restoreId)) {
    try {
      const _rsp = localStorage.getItem('activeProject') || '';
      const _rspQ = _rsp ? '?project=' + encodeURIComponent(_rsp) : '';
      const resolveResp = await fetch('/api/resolve-session/' + _restoreId + _rspQ);
      if (resolveResp.ok) {
        const resolved = await resolveResp.json();
        if (resolved.remapped && allSessions.find(s => s.id === resolved.id)) {
          _restoreId = resolved.id;
          localStorage.setItem('activeSessionId', _restoreId);
          const _fixUrl = new URL(window.location);
          _fixUrl.searchParams.set('chat', _restoreId);
          history.replaceState(null, '', _fixUrl);
        }
      }
    } catch(e) { /* resolve failed — fall through to dashboard */ }
  }

  if (_restoreId && allSessions.find(s => s.id === _restoreId)) {
    _skipChatHistory = true;
    openInGUI(_restoreId);
    _skipChatHistory = false;
    // Ensure URL reflects the restored session (replaceState, not push,
    // so we don't create a stale back-button entry).
    const _restoreUrl = new URL(window.location);
    if (!_restoreUrl.searchParams.has('chat') || _restoreUrl.searchParams.get('chat') !== _restoreId) {
      _restoreUrl.searchParams.set('chat', _restoreId);
      history.replaceState({ folder: null, chat: _restoreId }, '', _restoreUrl);
    }
  } else {
    document.getElementById('main-body').innerHTML = _buildDashboard();
  }
}

// ── The list holds its order while the pointer is on it ──────────────────
// A redraw that re-sorts the session list or card grid moves rows under the
// pointer, so a click aimed at one session lands on another.  While the mouse
// is over the list (and has moved in the last 20 s), or a finger is on it or
// scrolled it in the last 1.5 s, redraws that do not come from the person are
// held and run once, when the hold ends.  Rows still update in place
// (_updateRowState in socket.js); only their ORDER waits.  A redraw within
// 600 ms of the person's own click, key or input is theirs (a sort change, a
// pin, a filter) and runs at once.
const _SORT_HOLD_SEL = '#session-list, #workforce-grid';
const _SORT_HOLD_IDLE_MS = 20000;
const _SORT_HOLD_TOUCH_MS = 1500;
const _SORT_HOLD_USER_MS = 600;
const _sortHold = {mouseOver: false, movedAt: 0, touchDown: false, touchUntil: 0,
                   userAt: 0, pending: false, timer: null};
function _sortHeld() {
  const h = _sortHold, now = Date.now();
  if (now - h.userAt < _SORT_HOLD_USER_MS) return false;
  if (h.touchDown || now < h.touchUntil) return true;
  return h.mouseOver && now - h.movedAt < _SORT_HOLD_IDLE_MS;
}
function _sortHoldCheck() {
  const h = _sortHold;
  h.timer = null;
  if (!h.pending) return;
  if (_sortHeld()) { h.timer = setTimeout(_sortHoldCheck, 250); return; }
  h.pending = false;
  filterSessions();
}
function _onSessionList(t) {
  return !!(t && t.closest && t.closest(_SORT_HOLD_SEL));
}
(function _wireSortHold() {
  const h = _sortHold;
  const mine = () => { h.userAt = Date.now(); };
  ['click', 'keydown', 'input', 'change'].forEach(ev => document.addEventListener(ev, mine, true));
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    h.mouseOver = _onSessionList(e.target);
    h.movedAt = Date.now();
  }, {capture: true, passive: true});
  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) h.mouseOver = false;   // left the window
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' && _onSessionList(e.target)) h.touchDown = true;
  }, {capture: true, passive: true});
  const lift = () => {
    if (!h.touchDown) return;
    h.touchDown = false;
    h.touchUntil = Date.now() + _SORT_HOLD_TOUCH_MS;
  };
  document.addEventListener('pointerup', lift, true);
  document.addEventListener('pointercancel', lift, true);
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    if (h.mouseOver) { h.movedAt = Date.now(); return; }   // wheel reading
    if (_onSessionList(t) || t.querySelector(_SORT_HOLD_SEL)) {
      h.touchUntil = Math.max(h.touchUntil, Date.now() + _SORT_HOLD_TOUCH_MS);
    }
  }, {capture: true, passive: true});
})();

// ── Smooth reorder: rows glide to their new place (FLIP) ─────────────────
// renderList / renderWorkforce rebuild the container with innerHTML, so a
// re-sort used to make rows jump.  _flipReorder measures every row by its
// session id before the redraw, and after it starts each moved row at its old
// place and lets it slide to the new one; a row that is new to the list fades
// in.  It moves rows with the `translate` property, not `transform`: the
// hairline finish pins cards to `transform: none !important`.  Positions are taken inside the container (scroll included), so a
// redraw that resets scrolling does not read as movement.  Rows far outside
// the visible area are not animated.  Reduced motion: no animation.
const _FLIP_MS = 260;
const _FLIP_ROW_SEL = '.session-item[data-sid], .wf-card[data-sid]';
function _flipSnapshot(el) {
  if (!el || !el.isConnected) return null;
  const box = el.getBoundingClientRect();
  if (!box.height) return null;
  const pos = new Map(), moving = new Set();
  el.querySelectorAll(_FLIP_ROW_SEL).forEach(r => {
    const b = r.getBoundingClientRect();
    if (r._vnFlip) moving.add(r.getAttribute('data-sid'));
    pos.set(r.getAttribute('data-sid'),
            {x: b.left - box.left + el.scrollLeft, y: b.top - box.top + el.scrollTop});
  });
  return {el, pos, moving};
}
function _flipPlay(snap) {
  if (!snap || !snap.pos.size || !snap.el.isConnected) return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = snap.el, box = el.getBoundingClientRect();
  const vh = window.innerHeight || 1000;
  let kept = 0, inFlight = false;
  const rows = [];
  el.querySelectorAll(_FLIP_ROW_SEL).forEach(r => {
    const b = r.getBoundingClientRect();
    const was = snap.pos.get(r.getAttribute('data-sid'));
    if (was) kept++;
    rows.push({r, b, was});
  });
  // A different list (project switch, a filter that swapped most rows):
  // nothing to glide between.
  if (!kept || kept < rows.length / 2) return;
  rows.forEach(({r, b, was}) => {
    if (was) {
      const dx = was.x - (b.left - box.left + el.scrollLeft);
      const dy = was.y - (b.top - box.top + el.scrollTop);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      const fromTop = b.top + dy;
      if ((b.bottom < -200 || b.top > vh + 200) && (fromTop + b.height < -200 || fromTop > vh + 200)) return;
      r.style.transition = 'none';
      r.style.translate = dx + 'px ' + dy + 'px';
      if (snap.moving.has(r.getAttribute('data-sid'))) inFlight = true;
    } else {
      if (b.bottom < 0 || b.top > vh) return;
      r.style.transition = 'none';
      r.style.opacity = '0';
    }
    r._vnFlip = true;
  });
  // Rows wait at their old place until the screen has drawn them there, and
  // only then slide.  A re-sort arrives in a burst of redraws and the page is
  // busy for ~200 ms after it; a slide started at once had run out its clock
  // before the first frame was drawn, so it showed as a jump.  A redraw that
  // lands meanwhile measures the rows where they wait, so it glides on from
  // there.
  const go = () => rows.forEach(({r}) => {
    if (!r._vnFlip || !r.isConnected) return;
    r.style.transition = 'translate ' + _FLIP_MS + 'ms cubic-bezier(.2,.8,.2,1), opacity ' + _FLIP_MS + 'ms ease';
    r.style.translate = '';
    r.style.opacity = '';
    setTimeout(() => { if (!r.style.translate) r.style.transition = ''; r._vnFlip = false; }, _FLIP_MS + 40);
  });
  // A row caught mid-slide by this redraw is already on screen and moving:
  // waiting two frames would freeze it in place, which read as a stutter.
  if (inFlight) { void el.offsetWidth; go(); }
  else requestAnimationFrame(() => requestAnimationFrame(go));
}
// Write a session list's markup only when it changed.  A re-sort arrives as
// a burst of 3-4 redraws, most of them identical, and each rebuild cost
// ~17 ms of parsing and layout for 130 cards: the hitches you could feel.
// The rows must also still stand in the order they were drawn: a pinned drag
// moves them by hand and its Escape redraws to put them back.  Returns
// whether it wrote.
function _vnRowOrder(el) {
  let o = '';
  el.querySelectorAll(_FLIP_ROW_SEL).forEach(r => { o += r.getAttribute('data-sid') + '\n'; });
  return o;
}
function _vnWriteRows(el, html) {
  if (el._vnHTML === html && el._vnOrder === _vnRowOrder(el)) { el._vnSkipped = true; return false; }
  el.innerHTML = html;
  el._vnHTML = html;
  el._vnOrder = _vnRowOrder(el);
  el._vnSkipped = false;
  return true;
}
function _flipReorder(id, render) {
  const el = document.getElementById(id);
  if (!el) { render(); return; }
  // Every row on screen now, by session id, with the markup it was drawn from.
  const old = new Map();
  el.querySelectorAll(_FLIP_ROW_SEL).forEach(r => old.set(r.getAttribute('data-sid'), r));
  const snap = _flipSnapshot(el);
  el._vnSkipped = false;
  render();
  if (el._vnSkipped) return;   // nothing was redrawn
  // Keep every row whose markup did not change: put the existing element in
  // the new one's place.  Rebuilding them all restarted each slide in
  // progress, the spinning status icons and hover states on every redraw
  // (a re-sort arrives as a burst of 3-4), which showed as hitches.  Rows
  // whose markup changed (status, title, selection) are the new elements.
  // Inline handlers carry over with the element; a pinned drag's Escape
  // still gets its order back, because the kept rows take the NEW order.
  el.querySelectorAll(_FLIP_ROW_SEL).forEach(r => {
    const html = r.outerHTML;
    const was = old.get(r.getAttribute('data-sid'));
    if (was && was !== r && was._vnHTML === html && !was.contains(r)) {
      r.replaceWith(was);
    } else {
      r._vnHTML = html;
    }
  });
  el._vnOrder = _vnRowOrder(el);
  _flipPlay(snap);
}

function filterSessions() {
  // A pinned card is being dragged (sessions.js _pinDragMove): a redraw would
  // replace it under the mouse.  The drag redraws when it ends.
  if (window._pinDragActive) return;
  // The pointer is on the list: keep its order until it leaves (see above).
  if (_sortHeld()) {
    _sortHold.pending = true;
    if (!_sortHold.timer) _sortHold.timer = setTimeout(_sortHoldCheck, 250);
    return;
  }
  _sortHold.pending = false;
  // Re-renders the session view.  In the Sessions view's cards and list the
  // "Show only" filters from the ••• menu apply (see "Session filters" below)
  // and the result is windowed (first 150, more on scroll).  Other views get
  // the full list: the filters are hidden there, so they must not narrow them.
  const inSessionList = viewMode === 'sessions'
    && (sessionDisplayMode === 'grid' || sessionDisplayMode === 'list');
  _syncSessionFilterMenu(inSessionList);
  if (viewMode === 'homepage') {
    if (typeof _updateHomepageStats === 'function') _updateHomepageStats();
    return;
  }
  if (viewMode === 'workplace') {
    renderWorkspace(wfSortedSessions(allSessions));
  } else if (viewMode === 'sessions' && sessionDisplayMode === 'control') {
    if (typeof renderMissionControl === 'function') renderMissionControl();
  } else if (viewMode === 'sessions' && sessionDisplayMode === 'grid') {
    const shown = wfSortedSessions(_applySessionFilters(allSessions));
    _flipReorder('workforce-grid', () => renderWorkforce(_windowSessions(shown)));
    _mountWindowSentinel(document.getElementById('workforce-grid'));
    _filterAutoFocus(shown);
  } else if (viewMode === 'sessions') {
    const shown = sortedSessions(_applySessionFilters(allSessions));
    _flipReorder('session-list', () => renderList(_windowSessions(shown)));
    _mountWindowSentinel(document.getElementById('session-list'));
    _filterAutoFocus(shown);
  } else if (viewMode === 'compose') {
    // Keep the Subsessions "Ad-hoc" family tree live as session state
    // changes stream in.  No-op when the Structured tab is active or the
    // renderer isn't loaded yet.
    if (typeof _renderAdhocSubsessions === 'function') _renderAdhocSubsessions();
  }
  // All projects view: label each row and card with its project (all-projects.js).
  if (window.VNAllProjects) VNAllProjects.decorate();
}

// ── Session filters: finding one session among a thousand ────────────────
// All client-side over SessionStore.  They live behind the funnel button
// (#sidebar-filter-btn) beside the ••• menu.  There is NO sidebar title filter: the "Search…" window is
// the one place you type, and it matches titles too.
// Filters:
//   working / needs / idle / sleeping   the session's status (OR'd together)
//   unread                              has an unread reply   (AND)
//   recent                              active in the last 7 days (AND)
// They persist per project in ONE localStorage key, 'vnSessionFilters'
// ({project: [chip, ...]}), so the funnel lights up with a dot while any is on.
// Tests: tests/test_session_filters.py.
const _SESSION_FILTERS_KEY = 'vnSessionFilters';
// No 'idle' filter: a stopped session waits on you or is Done (session-verb.js).
const _STATE_CHIPS = {working: 'working', needs: 'question', standby: 'standby', sleeping: 'sleeping'};
const _SESSION_CHIPS = ['working', 'needs', 'standby', 'sleeping', 'unread', 'recent'];
const _SESSION_CHIP_LABELS = {working: 'Working', needs: 'Needs you', standby: 'Standby', idle: 'Idle',
  sleeping: 'Done', unread: 'Unread', recent: 'Last 7 days'};   // a sleeping session shows as Done (session-verb.js)

function _readAllSessionFilters() {
  try { return JSON.parse(localStorage.getItem(_SESSION_FILTERS_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}

/** The active chips for the current project, as a Set. */
function _activeSessionFilters() {
  const proj = (window.VNAllProjects ? VNAllProjects.settingsKey() : (localStorage.getItem('activeProject') || ''));
  const list = _readAllSessionFilters()[proj];
  return new Set(Array.isArray(list) ? list.filter(c => _SESSION_CHIPS.includes(c)) : []);
}

function toggleSessionFilter(chip) {
  if (!_SESSION_CHIPS.includes(chip)) return;
  const proj = (window.VNAllProjects ? VNAllProjects.settingsKey() : (localStorage.getItem('activeProject') || ''));
  const all = _readAllSessionFilters();
  const cur = _activeSessionFilters();
  if (cur.has(chip)) cur.delete(chip); else cur.add(chip);
  if (cur.size) all[proj] = Array.from(cur); else delete all[proj];
  try { localStorage.setItem(_SESSION_FILTERS_KEY, JSON.stringify(all)); } catch (e) { /* private mode */ }
  _resetSessionWindow();
  filterSessions();
}

/** "Show all sessions" in the funnel menu: drop every filter for this project. */
function clearSessionFilters() {
  const proj = (window.VNAllProjects ? VNAllProjects.settingsKey() : (localStorage.getItem('activeProject') || ''));
  const all = _readAllSessionFilters();
  delete all[proj];
  try { localStorage.setItem(_SESSION_FILTERS_KEY, JSON.stringify(all)); } catch (e) { /* private mode */ }
  closeFilterMenu();
  _resetSessionWindow();
  filterSessions();
}

// ── Filter auto-focus ──
// While a filter is on, the list follows the sessions that come and go:
//   - the list was empty and a session comes in → open it;
//   - the open session leaves the list → open the top one in the sort, or
//     close it when nothing else matches (never show a hidden session).
// Only a live change does this: turning a filter on/off, switching project or
// the first draw never moves you.  Nor does it while you are typing.
let _afPrev = null;
function _filterAutoFocus(sorted) {
  const chips = _activeSessionFilters();
  const proj = (window.VNAllProjects ? VNAllProjects.settingsKey() : (localStorage.getItem('activeProject') || ''));
  const key = proj + '|' + sessionDisplayMode + '|' + Array.from(chips).sort().join(',');
  const ids = sorted.map(s => s.id);
  const prev = _afPrev;
  _afPrev = {key, ids: new Set(ids)};
  if (!chips.size || !prev || prev.key !== key) return;
  const cameIn = prev.ids.size === 0 && ids.length > 0;
  const wentOut = activeId && prev.ids.has(activeId) && !ids.includes(activeId);
  if (!cameIn && !wentOut) return;
  const ae = document.activeElement;
  if (ae && (ae.isContentEditable || ((ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') && ae.value))) return;
  if (!ids.length) {
    // The open session left and nothing else matches: close it, so the
    // panel never shows a session the filter hides.  Its row is kept.
    const left = activeId;
    setTimeout(() => { if (activeId === left && typeof deselectSession === 'function') deselectSession(); }, 0);
    return;
  }
  const target = ids[0];
  if (target === activeId) return;
  setTimeout(() => { if (target !== activeId && typeof openInGUI === 'function') openInGUI(target); }, 0);
}

/** True when a status change can move a session in or out of the filtered list. */
function _sessionFiltersDependOnState() {
  const cur = _activeSessionFilters();
  for (const c of cur) if (_STATE_CHIPS[c]) return true;
  return cur.has('unread');
}

function _applySessionFilters(list) {
  const chips = _activeSessionFilters();
  if (!chips.size) return list;
  const states = new Set();
  for (const c of chips) if (_STATE_CHIPS[c]) states.add(_STATE_CHIPS[c]);
  const wantUnread = chips.has('unread');
  const since = chips.has('recent') ? Date.now() / 1000 - 7 * 86400 : 0;
  return list.filter(s => {
    // "Needs you" = any of the person's moves (session-verb.js), not only a permission prompt.
    if (states.size && !states.has(window.SessionVerb ? window.SessionVerb.filterBucket(s.id) : getSessionStatus(s.id))) return false;
    if (wantUnread && !(typeof hasUnread === 'function' && hasUnread(s.id))) return false;
    if (since && (s.effective_ts || s.last_activity_ts || s.sort_ts || 0) < since) return false;
    return true;
  });
}

/** Show the funnel where the filters apply, tick the active ones, and light
 *  the funnel with a dot while any is on (they persist, and a list narrowed
 *  by a filter nobody can see would look like missing sessions). */
function _syncSessionFilterMenu(show) {
  const wrap = document.getElementById('sidebar-filter-wrap');
  const btn = document.getElementById('sidebar-filter-btn');
  const clear = document.getElementById('sidebar-filter-clear');
  const cur = show ? _activeSessionFilters() : new Set();
  if (!wrap) return;
  wrap.hidden = !show;
  if (!show) closeFilterMenu();
  wrap.querySelectorAll('.sidebar-filter-opt[data-filter]').forEach(b => {
    const on = cur.has(b.dataset.filter);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if (clear) clear.hidden = cur.size === 0;
  if (window.VNTopbar && VNTopbar.syncCountFilters) VNTopbar.syncCountFilters();   // the counts under the list are filters too
  if (btn) {
    btn.classList.toggle('has-filter', cur.size > 0);
    btn.title = cur.size
      ? 'Filter · showing only: ' + _SESSION_CHIPS.filter(c => cur.has(c)).map(c => _SESSION_CHIP_LABELS[c]).join(', ')
      : 'Filter';
  }
}

// ── Windowed rendering ──
// The cards and list render the first 150 sessions; a sentinel at the end of
// the container, watched by an IntersectionObserver, adds 150 more as it
// scrolls into view, so a thousand cards never all mount on every render.
const _SESSION_WINDOW_STEP = 150;
let _sessionWindowLimit = _SESSION_WINDOW_STEP;
let _sessionWindowProject = null;
let _sessionWindowTotal = 0;
let _sessionWindowIds = new Set();
let _sessionWindowIO = null;

function _resetSessionWindow() { _sessionWindowLimit = _SESSION_WINDOW_STEP; }

function _windowSessions(sorted) {
  const proj = localStorage.getItem('activeProject') || '';
  if (proj !== _sessionWindowProject) { _sessionWindowProject = proj; _resetSessionWindow(); }
  _sessionWindowTotal = sorted.length;
  const out = sorted.length > _sessionWindowLimit ? sorted.slice(0, _sessionWindowLimit) : sorted;
  _sessionWindowIds = new Set(out.map(s => s.id));
  return out;
}

/** Is this session inside the rendered window (so it should have a row)? */
function _sessionInRenderWindow(id) { return _sessionWindowIds.has(id); }

function _mountWindowSentinel(container) {
  if (_sessionWindowIO) { _sessionWindowIO.disconnect(); _sessionWindowIO = null; }
  // A redraw that changed nothing keeps the old rows (_vnWriteRows), and the
  // old sentinel with them: never leave two.
  if (container) container.querySelectorAll(':scope > .session-window-sentinel').forEach(n => n.remove());
  if (!container || _sessionWindowTotal <= _sessionWindowLimit) return;
  const s = document.createElement('div');
  s.className = 'session-window-sentinel';
  s.setAttribute('aria-hidden', 'true');
  container.appendChild(s);
  if (typeof IntersectionObserver !== 'function') return;
  _sessionWindowIO = new IntersectionObserver((entries) => {
    if (!entries.some(e => e.isIntersecting)) return;
    _sessionWindowIO.disconnect();
    _sessionWindowIO = null;
    _sessionWindowLimit += _SESSION_WINDOW_STEP;
    filterSessions();
  }, { root: container, rootMargin: '0px 0px 400px 0px' });
  _sessionWindowIO.observe(s);
}

// ── "Name N untitled sessions" ──
// Appears in the sidebar when the project has >= 10 untitled sessions.  The
// count comes from GET /api/sessions/untitled-count ({project, total,
// untitled, nameable}); the run is POST /api/sessions/name-untitled, and its
// progress arrives as the `naming_progress` socket event ({project, done,
// total, current_title, named, skipped, failed, finished}), shown in a notice
// that sits in the shared float stack (a .vn-undo-toast, so _floatEls() and
// _layoutFloats() place it; see CLAUDE.md "Floating notices share ONE stack").
// Any failure of the count (404 on a server without the endpoint) hides it.
const _NAME_UNTITLED_MIN = 10;

async function _refreshUntitledButton() {
  const btn = document.getElementById('btn-name-untitled');
  if (!btn) return;
  // Bulk naming works on one project; not offered in All projects.
  if (window.VNAllProjects && VNAllProjects.on()) { btn.hidden = true; window._untitledInfo = null; return; }
  const proj = localStorage.getItem('activeProject') || '';
  try {
    const r = await fetch('/api/sessions/untitled-count?project=' + encodeURIComponent(proj), { cache: 'no-store' });
    if (!r.ok) { btn.hidden = true; window._untitledInfo = null; return; }
    const d = await r.json();
    if ((localStorage.getItem('activeProject') || '') !== proj) return;   // project switched meanwhile
    const untitled = Number(d && d.untitled) || 0;
    const nameable = Number(d && d.nameable != null ? d.nameable : untitled) || 0;
    // The homepage strip shows the same action (toolbar.js _hpStatusStrip).
    window._untitledInfo = { project: proj, untitled, nameable };
    if (viewMode === 'homepage' && typeof _updateHomepageStats === 'function') _updateHomepageStats();
    if (untitled >= _NAME_UNTITLED_MIN && nameable > 0) {
      btn.textContent = 'Name ' + nameable + ' untitled session' + (nameable === 1 ? '' : 's');
      btn.hidden = false;
    } else {
      btn.hidden = true;
    }
  } catch (e) {
    btn.hidden = true;
    window._untitledInfo = null;
  }
}

async function nameUntitledSessions() {
  const btn = document.getElementById('btn-name-untitled');
  const proj = localStorage.getItem('activeProject') || '';
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/sessions/name-untitled?project=' + encodeURIComponent(proj), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (r.status === 409) { showToast('Naming is already running for this project'); return; }
    if (!r.ok) { showToast('Could not start naming', true); if (btn) btn.disabled = false; return; }
    if (btn) btn.hidden = true;
    window._untitledInfo = null;   // the homepage strip's copy of the button goes too
    if (viewMode === 'homepage' && typeof _updateHomepageStats === 'function') _updateHomepageStats();
    _showNamingProgress({ project: proj, done: 0, total: 0, current_title: '' });
  } catch (e) {
    showToast('Could not start naming: network error', true);
    if (btn) btn.disabled = false;
  }
}

let _namingHideTimer = null;
function _showNamingProgress(d) {
  let el = document.getElementById('vn-naming-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'vn-naming-toast';
    el.className = 'vn-undo-toast vn-naming-toast';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="vn-undo-toast-msg"></span>';
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.classList.add('show'); _updateFloatOffset(); });
  }
  if (_namingHideTimer) { clearTimeout(_namingHideTimer); _namingHideTimer = null; }
  const msg = el.querySelector('.vn-undo-toast-msg');
  let text;
  if (d.finished) {
    const n = Number(d.named) || 0;
    text = 'Named ' + n + ' session' + (n === 1 ? '' : 's')
      + (d.failed ? ' · ' + d.failed + ' failed' : '');
  } else if (d.total) {
    text = 'Naming sessions ' + (d.done || 0) + '/' + d.total
      + (d.current_title ? ' · ' + d.current_title : '');
  } else {
    text = 'Naming untitled sessions…';
  }
  msg.textContent = text;
  el.title = text;
  _updateFloatOffset();
  if (d.finished) {
    _namingHideTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.remove(); _updateFloatOffset(); }, 300);
    }, 4000);
  }
}

/** Socket `naming_progress` (socket.js). */
function _onNamingProgress(d) {
  if (!d) return;
  if (d.project && d.project !== (localStorage.getItem('activeProject') || '')) return;
  _showNamingProgress(d);
  if (d.finished) {
    const btn = document.getElementById('btn-name-untitled');
    if (btn) btn.disabled = false;
    _refreshUntitledButton();
  }
}

// ===== Model / Thinking / Template / Department selectors =====

// --- Model Selector ---
// Migrate old short aliases ('sonnet', 'haiku', 'opus') stored in localStorage to
// full model IDs.  Short aliases work at the CLI level but full IDs are more
// explicit and avoid any version-specific alias resolution differences.
const _MODEL_ALIAS_MIGRATION = {
  'opus':   'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku':  'claude-haiku-4-5',
};
(function _migrateModelId() {
  const stored = localStorage.getItem('defaultModel');
  if (stored && _MODEL_ALIAS_MIGRATION[stored]) {
    localStorage.setItem('defaultModel', _MODEL_ALIAS_MIGRATION[stored]);
  }
})();
// One-time switch of every device's default to Opus 5.5, the new house default.
// Runs once per browser; a later pick in the Model selector still sticks.
if (!localStorage.getItem('defaultModel_opus55_set')) {
  localStorage.setItem('defaultModel', 'claude-opus-5-5');
  localStorage.setItem('defaultModel_opus55_set', '1');
}
let defaultModel = localStorage.getItem('defaultModel') || 'claude-opus-5-5';

// Group model entries by family (Fable / Opus / Sonnet / Haiku) and render a
// compact, deliberate grouped selector.  Shared by the system Model picker
// (openModelSelector) and the per-session selector (_openSessionModelSelector)
// so both stay visually consistent.
const _MODEL_FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];
const _MODEL_FAMILY_DOT = { fable: '#e0b341', opus: '#a855f7', sonnet: '#3b82f6', haiku: '#22c4a0' };
const _MSEL_CHECK = '<svg class="msel-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/** Parse a model entry into {id, family, version, is1m}. */
function _parseModelEntry(m) {
  const id = m.id || '';
  const is1m = /\[1m\]/i.test(id);
  const core = id.replace(/^claude-/, '').replace(/\[1m\]/i, '').replace(/-\d{8}$/, '');
  const parts = core.split('-').filter(Boolean);
  return { id, family: (parts[0] || '').toLowerCase(), version: parts.slice(1).join('.'), is1m };
}

/** Build grouped-by-family selector HTML. Rows carry data-model; caller wires clicks. */
function _modelSelectorGroupsHtml(models, selectedId) {
  // ONE chip per model, with no "1M" tag (it would sit on nearly every chip).
  // A separate "5.5" / "5.5 1M" pair would mislead: Fable, Opus and Sonnet
  // sessions launched on the plain id can already run to ~1M tokens, so the
  // plain chip is 1M too.  Haiku rejects 1M (API 400), so it is untagged.  The family
  // rule matches window._ctxWindowFor, so the picker, the model badge and the
  // context bar all say the same thing.
  const _plain = id => String(id || '').replace(/\[[^\]]*\]/g, '');
  const _base = [];
  (models || []).forEach(m => {
    if (!m) return;
    const id = _plain(m.id);
    if (id && !_base.some(x => x.id === id)) {
      _base.push(Object.assign({}, m, {id: id, name: _plain(m.name),
        _ctx1m: /^claude-(fable|opus|sonnet)-/.test(id)}));
    }
  });
  models = _base;
  selectedId = _plain(selectedId);
  const groups = {};
  const seen = [];
  for (const m of (models || [])) {
    const p = _parseModelEntry(m);
    if (!groups[p.family]) { groups[p.family] = []; seen.push(p.family); }
    groups[p.family].push({ m, p });
  }
  // Known families first (Fable, Opus, Sonnet, Haiku), then any extras as encountered.
  const fams = _MODEL_FAMILY_ORDER.filter(f => groups[f])
    .concat(seen.filter(f => !_MODEL_FAMILY_ORDER.includes(f)));

  let html = '';
  for (const f of fams) {
    const dot = _MODEL_FAMILY_DOT[f] || 'var(--text-faint)';
    const label = f ? f.charAt(0).toUpperCase() + f.slice(1) : 'Other';
    html += '<div class="msel-group-hd"><span class="msel-dot" style="background:' + dot + '"></span>'
      + '<span class="msel-group-name">' + escHtml(label) + '</span></div>';
    // Within a family: higher version first; each version's 1M variant follows it.
    const entries = groups[f].slice().sort((a, b) =>
      (a.p.version !== b.p.version)
        ? b.p.version.localeCompare(a.p.version, undefined, { numeric: true })
        : (a.p.is1m === b.p.is1m ? 0 : (a.p.is1m ? 1 : -1)));
    for (const { m, p } of entries) {
      const active = (m.id === selectedId);
      const verLabel = p.version || m.name || m.id || '';
      html += '<div class="msel-row' + (active ? ' active' : '') + '" data-model="' + escHtml(m.id || '') + '" role="button" tabindex="0">'
        + _MSEL_CHECK
        + '<span class="msel-name">' + escHtml(verLabel) + '</span>'
        // No "1M" tag on the chips: nearly every model has the 1M window, so the tag
        // was on almost all of them and said nothing.  (m._ctx1m is still computed above.)
        + '</div>';
    }
  }
  return html;
}

async function openModelSelector() {
  const overlay = document.getElementById('pm-overlay');

  // Show loading state
  overlay.innerHTML = '<div class="pm-card pm-enter" style="width:380px;"><h2 class="pm-title">Select Model</h2><div class="pm-body"><span class="spinner"></span> Loading models...</div></div>';
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.querySelector('.pm-card').classList.remove('pm-enter'));
  overlay.onclick = e => { if (e.target === overlay) _closePm(); };

  // Fetch models dynamically from server
  let models;
  try {
    const resp = await fetch('/api/models');
    models = await resp.json();
  } catch (e) {
    // Fallback list uses full model IDs — same as server aliases
    models = [
      {id: 'claude-fable-5-2', name: 'Fable 5.2',  desc: 'Most capable, 1M context'},
      {id: 'claude-fable-5-1', name: 'Fable 5.1',  desc: 'Previous Fable, 1M context'},
      {id: 'claude-fable-5',   name: 'Fable 5',    desc: 'Deep reasoning, 1M context'},
      {id: 'claude-opus-5-5',  name: 'Opus 5.5',   desc: 'Newest Opus, Fable-level, faster + cheaper'},
      {id: 'claude-opus-5',    name: 'Opus 5',     desc: 'Agentic coding, 1M context'},
      {id: 'claude-opus-4-8',  name: 'Opus 4.8',   desc: 'Deep reasoning, 1M context'},
      {id: 'claude-opus-4-7',  name: 'Opus 4.7',   desc: '1M context, deepest reasoning'},
      {id: 'claude-opus-4-6',  name: 'Opus 4.6',   desc: 'Deep reasoning, 200K context'},
      {id: 'claude-sonnet-5-5',name: 'Sonnet 5.5', desc: 'Newest Sonnet, 1M context'},
      {id: 'claude-sonnet-5',  name: 'Sonnet 5',   desc: 'Fast + capable, 1M context'},
      {id: 'claude-sonnet-4-6',name: 'Sonnet 4.6', desc: 'Fast, capable, balanced'},
      {id: 'claude-haiku-5-5', name: 'Haiku 5.5',  desc: 'Newest Haiku, fastest, 1M context'},
      {id: 'claude-haiku-4-5', name: 'Haiku 4.5',  desc: 'Fastest, most cost-efficient'},
    ];
  }

  const groupsHtml = _modelSelectorGroupsHtml(models, defaultModel);

  overlay.innerHTML = '<div class="pm-card" style="width:380px;">'
    + '<h2 class="pm-title">Select Model</h2>'
    + '<div class="pm-body" style="margin-bottom:14px;"><p>Choose the default model for new sessions.</p></div>'
    + '<div class="msel-list">' + groupsHtml + '</div>'
    + '<div class="pm-actions" style="margin-top:18px;"><button class="pm-btn pm-btn-secondary" id="pm-model-close">Close</button></div></div>';

  document.getElementById('pm-model-close').onclick = () => _closePm();
  overlay.onclick = e => { if (e.target === overlay) _closePm(); };
  overlay.querySelectorAll('.msel-row').forEach(row => {
    row.onclick = () => {
      // Chips carry plain ids (the 1M window comes with the model; see
      // _modelSelectorGroupsHtml).  Strip any marker defensively.
      defaultModel = (row.dataset.model || '').replace(/\[[^\]]*\]/g, '');
      localStorage.setItem('defaultModel', defaultModel);
      _closePm();
      _updateModelLabel();
      showToast('Model: ' + (_modelLabel(defaultModel) || 'Default'));
    };
  });
}

/** Return a short human-readable label for a model ID string.
 *  Handles both full IDs (e.g. 'claude-sonnet-4-6') and legacy short aliases
 *  ('sonnet', 'haiku', 'opus') so users who had old localStorage values still
 *  see correct labels without needing to re-select.
 */
function _modelLabel(modelId) {
  if (!modelId) return 'Opus 5.5';
  // Legacy short aliases from old localStorage values
  if (modelId === 'opus')   return 'Opus 4.6';
  if (modelId === 'sonnet') return 'Sonnet 4.6';
  if (modelId === 'haiku')  return 'Haiku 4.5';
  if (modelId === 'fable')  return 'Fable 5';
  // Generic: claude-<family>-<major>[-<minor>][-YYYYMMDD] with optional
  // trailing capability marker like [1m].  Handles ANY family (opus,
  // sonnet, haiku, fable, …) so new models never fall back to raw ids.
  const m = modelId.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?/);
  if (m) {
    const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    const ver = m[2] + (m[3] ? '.' + m[3] : '');
    return fam + ' ' + ver + (modelId.includes('[1m]') ? ' [1m]' : '');
  }
  return modelId;
}

function _updateModelLabel() {
  const el = document.getElementById('sys-model-label');
  if (el) el.textContent = _modelLabel(defaultModel);
}
_updateModelLabel();

// --- Thinking Level Selector ---
// Sanitized through SessionModel: the removed "None" option stored 'none',
// which never disabled thinking.
let defaultThinking = (typeof SessionModel !== 'undefined')
  ? SessionModel.getDefaultThinking()
  : ((localStorage.getItem('defaultThinking') || '').replace(/^none$/, ''));

function openThinkingSelector() {
  const overlay = document.getElementById('pm-overlay');
  const levels = SessionModel.THINKING_LEVELS;
  let html = '<div class="pm-card pm-enter" style="width:380px;">'
    + '<h2 class="pm-title">Thinking Level</h2>'
    + '<div class="pm-body"><p>Effort level for new sessions. Higher levels think longer and cost more. '
    + 'Change a running session from its model badge.</p></div>'
    + '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">';
  for (const l of levels) {
    const isActive = l.key === defaultThinking;
    html += `<div class="add-mode-card${isActive ? ' active' : ''}" data-level="${l.key}">
      <div class="add-mode-info">
        <div class="add-mode-title">${l.label}</div>
        <div class="add-mode-desc">${l.desc}</div>
      </div>
    </div>`;
  }
  html += '</div><div class="pm-actions"><button class="pm-btn pm-btn-secondary" id="pm-think-close">Close</button></div></div>';
  overlay.innerHTML = html;
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.querySelector('.pm-card').classList.remove('pm-enter'));
  document.getElementById('pm-think-close').onclick = () => _closePm();
  overlay.onclick = e => { if (e.target === overlay) _closePm(); };
  overlay.querySelectorAll('.add-mode-card').forEach(card => {
    card.onclick = () => {
      defaultThinking = card.dataset.level;
      localStorage.setItem('defaultThinking', defaultThinking);
      _closePm();
      _updateThinkingLabel();
      showToast('Thinking: ' + card.querySelector('.add-mode-title').textContent);
    };
  });
}

function _updateThinkingLabel() {
  const el = document.getElementById('sys-thinking-label');
  if (!el) return;
  // app.js loads BEFORE session-model.js, so this first runs without the store.
  el.textContent = (typeof SessionModel !== 'undefined')
    ? SessionModel.thinkingLabel(defaultThinking)
    : (defaultThinking === 'xhigh' ? 'xHigh'
      : defaultThinking ? defaultThinking.charAt(0).toUpperCase() + defaultThinking.slice(1)
      : 'Default');
}
_updateThinkingLabel();

// --- Preferences Modal ---
function openPreferences() {
  const overlay = document.getElementById('pm-overlay');

  // Current setting states
  const enterToSend = sendBehavior === 'enter';
  const stickyOn = localStorage.getItem('stickyUserMsgs') !== 'off';
  const wsdOn = window._wrongSessionDetectionEnabled !== false;
  const stOn = window._smartTerminationEnabled !== false;  // on by default
  const unreadOn = typeof unreadDotsEnabled === 'function' ? unreadDotsEnabled() : true;

  const snOn = !!(window.SpeechNode && window.SpeechNode.isEnabled());

  // Each setting renders as one compact row: label + one-line hint + a toggle switch.
  const rows = [
    {key: 'speechnode', label: 'SpeechNode voice', on: snOn,
     hint: 'Local, codebase-aware voice that works in every browser (Firefox & Safari too). Downloads a small model on first enable.'},
    {key: 'send', label: 'Enter to send', on: enterToSend,
     hint: 'Press Enter to send. When off, ' + _MOD + '+Enter sends and Enter adds a new line.'
       + (_isTouchKeyboard() ? ' On a touch screen Enter always adds a new line; use the send button.' : '')},
    {key: 'livescroll', label: 'Auto scroll (default)',
     on: !!(window.ThreadScroll && ThreadScroll.getDefaultLiveScroll()),
     hint: 'Whether sessions follow new output as it arrives. When off, the chat stays where you are and the arrow shows Working, Needs you or Done. The Auto switch on that arrow changes just the session you are in.'},
    {key: 'classicscroll', label: 'Classic scroll',
     on: !!(window.ThreadScroll && ThreadScroll.isClassic && ThreadScroll.isClassic()),
     hint: 'The original chat scrolling: it follows new output, and a small "N new" pill jumps to the bottom. Replaces the Auto scroll setting while on. Also flipped by the faint double arrow beside the jump button.'},
    {key: 'sticky', label: 'Sticky chats', on: stickyOn,
     hint: 'Keep your most recent message pinned at the top while scrolling long replies.'},
    {key: 'wsd', label: 'Wrong-session detection', on: wsdOn,
     hint: 'Warn before sending a prompt that looks meant for a different active session.'},
    {key: 'smartterm', label: 'Smart termination', on: stOn,
     hint: 'Every session ends its turn with what it is working on, where it stands and what it needs from you, and thinks again before stopping with work it could still do.'},
    {key: 'chrome', label: 'Chrome control', on: window._chromeControlEnabled === true,
     hint: 'Sessions can use your Chrome through the Claude in Chrome extension, to read pages and act on sites you are signed in to. Applies to sessions started or woken after you turn it on.'},
    {key: 'usagepace', label: 'Fast usage day warning', on: window._usagePaceWarning !== false,
     hint: 'A pop-up each time 24 hours spend another day of your weekly limit (a seventh of it), with Keep going or Stop all sessions.'},
    {key: 'usagespare', label: 'Spare usage suggestion', on: window._usageSpareSuggest !== false,
     hint: 'A pop-up when the week has twice the usage the days to the reset would normally use, offering to start a long job that runs by itself.'},
    {key: 'quietnudge', label: 'All-quiet publish reminder', on: !(window.VNQuietNudge && !VNQuietNudge.enabled()),
     hint: 'When this app’s own project is open and its sessions go from busy to none working or needing you, a small note beside the Publish button says you have changes not published.'},
    {key: 'unread', label: 'Unread indicators', on: unreadOn,
     hint: 'Show a small dot on idle chats that replied while you were looking elsewhere.'},
  ];

  let html = '<div class="pm-card pm-enter" style="width:400px;">'
    + '<h2 class="pm-title">Preferences</h2>'
    + '<div class="pref-list">';
  for (const r of rows) {
    html += `<div class="pref-row">
        <div class="pref-row-text">
          <div class="pref-row-label">${r.label}</div>
          <div class="pref-row-hint">${r.hint}</div>
        </div>
        <button class="pref-toggle${r.on ? ' on' : ''}" role="switch" aria-checked="${r.on ? 'true' : 'false'}" data-toggle="${r.key}" title="Toggle ${r.label}"><span class="pref-toggle-knob"></span></button>
      </div>`;
  }
  html += '</div>'
    + '<div class="pm-actions"><button class="pm-btn pm-btn-secondary" id="pm-pref-close">Close</button></div></div>';

  overlay.innerHTML = html;
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.querySelector('.pm-card').classList.remove('pm-enter'));
  document.getElementById('pm-pref-close').onclick = () => _closePm();
  overlay.onclick = e => { if (e.target === overlay) _closePm(); };

  // Server-saved switches can be flipped from another tab or the phone; the
  // values above came from this page's load.  Re-read them so the switch shows
  // what the sessions are actually running with, no reload needed.
  fetch('/api/kanban/config').then(r => r.ok ? r.json() : null).then(cfg => {
    if (!cfg) return;
    const sync = (key, on) => {
      const b = overlay.querySelector('.pref-toggle[data-toggle="' + key + '"]');
      const shown = rows.find(r => r.key === key);
      // Skip a switch the user already flipped while this was loading.
      if (!b || !shown || b.classList.contains('on') !== shown.on) return;
      if (key === 'smartterm') {
        if (typeof window.applySmartTerminationView === 'function') window.applySmartTerminationView(on);
        else window._smartTerminationEnabled = on;
      }
      if (key === 'wsd') window._wrongSessionDetectionEnabled = on;
      if (key === 'chrome') window._chromeControlEnabled = on;
      if (key === 'usagepace') window._usagePaceWarning = on;
      if (key === 'usagespare') window._usageSpareSuggest = on;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    };
    sync('smartterm', cfg.smart_termination !== false);
    sync('wsd', cfg.wrong_session_detection !== false);
    sync('chrome', cfg.chrome_control === true);
    sync('usagepace', cfg.usage_pace_warning !== false);
    sync('usagespare', cfg.usage_spare_suggest !== false);
    sync('quietnudge', cfg.quiet_publish_nudge !== false && !(window.VNQuietNudge && !VNQuietNudge.enabled()));
  }).catch(() => {});

  // Toggle handlers. The modal stays open so several settings can be flipped at once.
  overlay.querySelectorAll('.pref-toggle').forEach(btn => {
    btn.onclick = () => {
      const on = !btn.classList.contains('on');
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      switch (btn.dataset.toggle) {
        case 'send':
          _setSendBehavior(on ? 'enter' : 'ctrl-enter');   // also saves it to the server
          showToast('Enter to send: ' + (on ? 'On' : 'Off'));
          break;
        case 'livescroll':
          // The DEFAULT for every session (resets per-session overrides).
          if (window.ThreadScroll) ThreadScroll.setDefaultLiveScroll(on);
          if (typeof _renderLiveScrollAction === 'function') _renderLiveScrollAction();
          showToast('Auto scroll default: ' + (on ? 'On' : 'Off'));
          break;
        case 'classicscroll':
          // thread-scroll-classic.js: the classic thread. It shows its own toast.
          if (window.ThreadScroll && ThreadScroll.setClassic) ThreadScroll.setClassic(on);
          break;
        case 'sticky': {
          if (on) {
            localStorage.removeItem('stickyUserMsgs');
            // Re-init on current conversation
            const c = document.getElementById('live-log') || document.getElementById('convo');
            if (c && typeof initStickyUserMessages === 'function') initStickyUserMessages(c);
          } else {
            localStorage.setItem('stickyUserMsgs', 'off');
            // Remove any active pin immediately
            document.querySelectorAll('.msg.user.sticky-pinned').forEach(m => m.classList.remove('sticky-pinned'));
          }
          showToast('Sticky chats: ' + (on ? 'On' : 'Off'));
          break;
        }
        case 'wsd':
          window._wrongSessionDetectionEnabled = on;
          // Persist to kanban config on the server (PUT merges into existing config)
          fetch('/api/kanban/config', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({wrong_session_detection: on})
          }).catch(() => { /* fail-open: in-memory flag is already set */ });
          showToast('Wrong-session detection: ' + (on ? 'On' : 'Off'));
          break;
        case 'smartterm':
          // Read by the Session Engine at every turn end (src/engine/smart_termination.py).
          // The sidebar statuses follow it at once (session-verb.js).
          if (typeof window.applySmartTerminationView === 'function') window.applySmartTerminationView(on);
          else window._smartTerminationEnabled = on;
          fetch('/api/kanban/config', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({smart_termination: on})
          }).catch(() => showToast('Smart termination: could not save', true));
          showToast('Smart termination: ' + (on ? 'On' : 'Off'));
          break;
        case 'chrome':
          window._chromeControlEnabled = on;
          // Read by the Session Engine at each launch and wake: adds --chrome
          // (SessionManager._with_chrome).
          fetch('/api/kanban/config', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({chrome_control: on})
          }).then(r => { if (!r.ok) throw new Error(); })
            .catch(() => showToast('Chrome control: could not save', true));
          showToast('Chrome control: ' + (on ? 'On for new and woken sessions' : 'Off'));
          break;
        case 'usagepace':
        case 'usagespare': {
          // Read by the web server before each pop-up fires (src/web/usage_pace.py).
          const key = btn.dataset.toggle === 'usagepace' ? 'usage_pace_warning' : 'usage_spare_suggest';
          if (btn.dataset.toggle === 'usagepace') window._usagePaceWarning = on; else window._usageSpareSuggest = on;
          fetch('/api/kanban/config', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({[key]: on})
          }).then(r => { if (!r.ok) throw new Error(); })
            .catch(() => showToast('Could not save that setting', true));
          showToast((btn.dataset.toggle === 'usagepace' ? 'Fast usage day warning: ' : 'Spare usage suggestion: ') + (on ? 'On' : 'Off'));
          break;
        }
        case 'quietnudge':
          // static/js/quiet-nudge.js: saved per device and in the server's preferences.
          if (window.VNQuietNudge) VNQuietNudge.setEnabled(on);
          showToast('All-quiet publish reminder: ' + (on ? 'On' : 'Off'));
          break;
        case 'unread':
          // localStorage-only, like 'sticky' — this is a per-device display
          // preference, not something the server or other clients need.
          if (on) {
            localStorage.removeItem('unreadDots');
          } else {
            localStorage.setItem('unreadDots', 'off');
            // Drop every existing flag so re-enabling later doesn't resurrect a
            // stale backlog of dots for sessions the user has since read.
            if (typeof clearAllUnread === 'function') clearAllUnread();
          }
          // Keep the <body> class in step so the reserved dot gutter appears
          // and disappears with the preference.
          if (typeof _applyUnreadBodyClass === 'function') _applyUnreadBodyClass();
          if (typeof filterSessions === 'function') filterSessions();
          showToast('Unread indicators: ' + (on ? 'On' : 'Off'));
          break;
        case 'speechnode':
          if (!window.SpeechNode) { showToast('SpeechNode is unavailable.', true); break; }
          if (on) {
            // One-click: go straight into setup (install + progress) — no second
            // confirmation. VibeNode owns the install UX (see speechnode-install.js):
            // resilient progress, a guaranteed success state, and the mic lights up
            // without a manual refresh. Fall back to the package flow if that module
            // somehow didn't load.
            if (window.VibeSpeechInstall) window.VibeSpeechInstall.enable();
            else window.SpeechNode.enable();
          } else {
            window.SpeechNode.setEnabled(false);
            showToast('SpeechNode disabled — using standard voice.');
            // force the bar to re-render (it skips on unchanged session state) so the mic updates now
            if (typeof updateLiveInputBar === 'function') {
              if (typeof liveBarState !== 'undefined') liveBarState = null;
              setTimeout(updateLiveInputBar, 0);
            }
          }
          break;
      }
    };
  });
}

// Server and Diagnostics: the two sections that used to share one "Developer
// Tools" popup.  Everything they ask or show is drawn INSIDE their own card
// (the restart choices, the Turn Off and scrub confirms, a test or scan run),
// so in the Settings window nothing opens a second window on top of it.
function _devRowsHtml(items) {
  return items.map(it => {
    const badge = it.badge ? ` <span class="sys-item-value">${it.badge}</span>` : '';
    return `<button class="dev-tool-row${it.danger ? ' danger' : ''}" data-action="${it.key}">
        <span class="dev-tool-text">
          <span class="dev-tool-label">${it.label}${badge}</span>
          <span class="dev-tool-hint">${it.hint}</span>
        </span>
      </button>`;
  }).join('');
}
function _devOpenCard(title, intro, inner) {
  const overlay = document.getElementById('pm-overlay');
  if (!overlay) return null;
  overlay.innerHTML = '<div class="pm-card pm-enter dev-card" style="width:420px;">'
    + '<h2 class="pm-title">' + title + '</h2>'
    + '<div class="pm-body"><p>' + intro + '</p></div>'
    + '<div class="dev-pane">' + inner + '</div>'
    + '<div class="pm-actions"><button class="pm-btn pm-btn-secondary dev-close">Close</button></div></div>';
  overlay.classList.add('show');
  const card = overlay.querySelector('.pm-card');
  requestAnimationFrame(() => card.classList.remove('pm-enter'));
  card.querySelector('.dev-close').onclick = () => _closePm();
  overlay.onclick = e => { if (e.target === overlay) _closePm(); };
  return card;
}
// An inline question in place of the rows: Cancel brings the rows back.
function _devAsk(card, opts) {
  const pane = card.querySelector('.dev-pane');
  pane.innerHTML = '<div class="dev-ask' + (opts.danger ? ' danger' : '') + '">'
    + '<div class="dev-ask-title">' + opts.title + '</div>'
    + '<div class="dev-ask-text">' + opts.text + '</div>'
    + '<div class="dev-ask-btns"><button class="pm-btn pm-btn-secondary dev-ask-no">Cancel</button>'
    + '<button class="pm-btn ' + (opts.danger ? 'pm-btn-danger dev-ask-danger' : 'pm-btn-primary') + ' dev-ask-yes">' + opts.yes + '</button></div></div>';
  pane.querySelector('.dev-ask-no').onclick = opts.back;
  pane.querySelector('.dev-ask-yes').onclick = opts.go;
}

function openServerTools() {
  const card = _devOpenCard('Server', 'Restart or stop VibeNode.', '');
  if (!card) return;
  const rows = () => {
    const pane = card.querySelector('.dev-pane');
    pane.innerHTML = '<div class="dev-tool-section-label">Restart</div>' + _devRowsHtml([
      {key: 'web', label: 'Application', hint: 'Quick refresh. Your running sessions stay alive.'},
      {key: 'daemon', label: 'Session Engine', hint: 'Restarts the Session Engine. All running sessions will stop.'},
      {key: 'both', label: 'Everything', hint: 'Full restart. All running sessions will stop.'},
    ]) + '<div class="dev-tool-section-label">Stop</div>' + _devRowsHtml([
      {key: 'shutdown', label: 'Turn Off Server', hint: 'Stop the server entirely.', danger: true},
    ]);
    pane.querySelectorAll('.dev-tool-row').forEach(btn => {
      btn.onclick = () => {
        const a = btn.dataset.action;
        if (a !== 'shutdown') { _closePm(); if (typeof _doRestart === 'function') _doRestart(a); return; }
        _devAsk(card, {
          title: 'Turn off the server?', danger: true, yes: 'Turn Off', back: rows,
          text: 'This stops both the web server (5050) and the Session Engine (5051). All running sessions and agents end, and DevelopNode has to be started again by hand.',
          go: () => { _closePm(); if (typeof _doShutdown === 'function') _doShutdown(); },
        });
      };
    });
  };
  rows();
}

// A test or scan run is drawn in the Diagnostics card: the run's own dialog
// (#git-sync-card, kept with its ids so test-runner.js and git-sync.js update
// it unchanged) is moved into the card while it runs, and back when it ends.
const _devDock = { card: null, host: null, obs: null };
function _devUndock(reason) {
  const gs = _devDock.card;
  if (!gs) return;
  const ov = document.getElementById('git-sync-overlay');
  _devDock.card = null;
  _devDock.host = null;
  gs.classList.add('pm-card');
  gs.classList.remove('dev-docked');
  if (ov) { ov.appendChild(gs); ov.classList.remove('gs-docked'); }
  if (reason === 'left' && ov && ov.classList.contains('show')) {
    // The card was closed or replaced mid-run: keep the run going as the pill.
    const acts = document.getElementById('git-sync-actions');
    if (acts && (!acts.children.length || acts.querySelector('[data-minimize]'))) minimizeGitSyncModal();
    else closeGitSyncModal();
  }
}
function _devDockRun(card, back) {
  const ov = document.getElementById('git-sync-overlay');
  const gs = document.getElementById('git-sync-card');
  if (!ov || !gs || !ov.classList.contains('show') || _devDock.card) return;
  const pane = card.querySelector('.dev-pane');
  pane.innerHTML = '<div class="dev-run"></div>';
  gs.classList.remove('pm-card');
  gs.classList.add('dev-docked');
  ov.classList.add('gs-docked');
  pane.firstChild.appendChild(gs);
  _devDock.card = gs;
  _devDock.host = card;
  if (!_devDock.obs) {
    _devDock.obs = new MutationObserver(() => {
      if (!_devDock.card) return;
      const ov2 = document.getElementById('git-sync-overlay');
      if (!document.body.contains(_devDock.card)) { _devUndock('left'); return; }
      if (ov2 && !ov2.classList.contains('show')) {
        const host = _devDock.host, done = _devDock.back;
        _devUndock('ended');
        if (host && document.body.contains(host) && done) done();
      }
    });
    _devDock.obs.observe(ov, { attributes: true, attributeFilter: ['class'] });
    _devDock.obs.observe(document.getElementById('pm-overlay'), { childList: true, subtree: true });
  }
  _devDock.back = back;
}

function openDiagnostics() {
  const card = _devOpenCard('Diagnostics', 'Tests, the security scan and clean-ups.', '');
  if (!card) return;
  const rows = () => {
    const phantomBadge = document.getElementById('sys-phantom-badge');
    const phantomCount = (phantomBadge && phantomBadge.textContent) || '';
    const pane = card.querySelector('.dev-pane');
    pane.innerHTML = _devRowsHtml([
      {key: 'test-fast', label: 'Run Tests (Fast)', hint: 'Quick test suite.'},
      {key: 'test-full', label: 'Run Tests (Full)', hint: 'Complete test suite.'},
      {key: 'scan', label: 'Security Scan', hint: 'Check the code for keys and personal details before publishing.'},
      {key: 'scrub', label: 'Scrub Phantom Names', hint: 'Remove name entries that point to deleted sessions.', badge: phantomCount},
    ]);
    pane.querySelectorAll('.dev-tool-row').forEach(btn => {
      btn.onclick = () => {
        switch (btn.dataset.action) {
          case 'test-fast': if (typeof runTests === 'function') runTests('fast'); break;
          case 'test-full': if (typeof runTests === 'function') runTests('full'); break;
          case 'scan':      if (typeof runCodeScan === 'function') runCodeScan(); break;
          case 'scrub':     _devScrub(card, rows); return;
        }
        _devDockRun(card, rows);
      };
    });
  };
  rows();
  // A run still going (minimized earlier) comes back into the card.
  const ov = document.getElementById('git-sync-overlay');
  if (typeof _gitSyncMinimized !== 'undefined' && _gitSyncMinimized && typeof _testRunning !== 'undefined' && _testRunning
      && typeof restoreGitSyncModal === 'function') {
    restoreGitSyncModal();
    if (ov && ov.classList.contains('show')) _devDockRun(card, rows);
  }
}

async function _devScrub(card, back) {
  const pane = card.querySelector('.dev-pane');
  const note = (text) => {
    pane.innerHTML = '<div class="dev-ask"><div class="dev-ask-text">' + text + '</div>'
      + '<div class="dev-ask-btns"><button class="pm-btn pm-btn-secondary dev-ask-no">Back</button></div></div>';
    pane.querySelector('.dev-ask-no').onclick = back;
  };
  pane.innerHTML = '<div class="dev-ask"><div class="dev-ask-text">Looking for phantom names…</div></div>';
  const call = async (dry) => {
    const r = await fetch('/api/admin/scrub-phantoms', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({dry_run: dry}),
    });
    return r.json();
  };
  let dry;
  try { dry = await call(true); } catch (e) { dry = null; }
  if (!dry || dry.ok !== true) { note('Could not check for phantom names. Try again.'); return; }
  const n = dry.total_removed || 0;
  if (!n) { note('No phantom session names to remove.'); if (typeof _refreshPhantomBadge === 'function') _refreshPhantomBadge(); return; }
  _devAsk(card, {
    title: 'Remove ' + n + ' phantom name' + (n === 1 ? '' : 's') + '?', yes: 'Remove', back,
    text: 'These name entries point to sessions that were deleted. No session is deleted, and each project’s name file is backed up before any change.',
    go: async () => {
      pane.innerHTML = '<div class="dev-ask"><div class="dev-ask-text">Removing…</div></div>';
      let res;
      try { res = await call(false); } catch (e) { res = null; }
      if (typeof _refreshPhantomBadge === 'function') _refreshPhantomBadge();
      note(res && res.ok === true ? 'Removed ' + res.total_removed + ' phantom session-name entries.' : 'The clean-up failed. Nothing was changed.');
    },
  });
}

function openWorkspaceTemplateSelector() {
  if (typeof showTemplateSelector !== 'function') {
    showToast('Folder system not loaded');
    return;
  }
  showTemplateSelector(() => {
    filterSessions();
    showToast('Workspace template applied');
  });
}

function openAddDepartment() {
  if (typeof FOLDER_SUPERSET === 'undefined' || typeof getFolderTree !== 'function') {
    showToast('Folder system not loaded');
    return;
  }
  const tree = getFolderTree();
  if (!tree) {
    showToast('Set up a workspace template first');
    return;
  }

  // Get available departments (root-level folders not already in tree)
  const existing = new Set(Object.keys(tree.folders));
  const available = Object.entries(FOLDER_SUPERSET)
    .filter(([id, def]) => !def.parentId && !existing.has(id))
    .map(([id, def]) => ({id, name: def.name, childCount: def.children.length}));

  if (!available.length) {
    showToast('All departments already added');
    return;
  }

  const overlay = document.getElementById('pm-overlay');
  let html = '<div class="pm-card pm-enter" style="width:420px;max-height:80vh;display:flex;flex-direction:column;">'
    + '<h2 class="pm-title">Add Department</h2>'
    + '<div class="pm-body" style="overflow-y:auto;flex:1;min-height:0;">'
    + '<p>Select a department to add to your workspace.</p>'
    + '<div style="display:flex;flex-direction:column;gap:6px;margin-top:12px;">';

  for (const dept of available) {
    html += `<div class="add-mode-card" data-dept="${dept.id}" style="padding:12px;">
      <div class="add-mode-info">
        <div class="add-mode-title">${escHtml(dept.name)}</div>
        <div class="add-mode-desc">${dept.childCount} sub-folders</div>
      </div>
    </div>`;
  }

  html += '</div></div>'
    + '<div class="pm-actions"><button class="pm-btn pm-btn-secondary" id="pm-dept-close">Close</button></div></div>';
  overlay.innerHTML = html;
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.querySelector('.pm-card').classList.remove('pm-enter'));
  document.getElementById('pm-dept-close').onclick = () => _closePm();
  overlay.onclick = e => { if (e.target === overlay) _closePm(); };

  overlay.querySelectorAll('.add-mode-card').forEach(card => {
    card.onclick = () => {
      const deptId = card.dataset.dept;
      addDepartmentFromSuperset(deptId);
      _closePm();
      filterSessions();
      showToast('Added ' + card.querySelector('.add-mode-title').textContent);
    };
  });
}



// Compose code moved to compose.js

// Shown inside developnode.com/app, the DevelopNode logo (the home button)
// goes to the website, the way a site's logo does. Everywhere else it opens
// the app's own home view (its inline onclick). Capture phase so this runs
// before that onclick; only a click inside the lockup is taken.
(function () {
  var SITE = /^https:\/\/(www\.)?developnode\.com$/;
  function inSite() {
    if (window.top === window) return false;
    var a = location.ancestorOrigins;
    if (a && a.length) return SITE.test(a[a.length - 1]);
    try { return SITE.test(new URL(document.referrer).origin); } catch (e) { return false; }
  }
  if (!inSite()) return;

  // Tell the site where the app is, so developnode.com/app's address carries
  // this one (developnode.com/app?chat=… is 127.0.0.1:5050/?chat=…) and the
  // tab shows this page's title. Only the address and title are sent.
  var site = (location.ancestorOrigins && location.ancestorOrigins.length)
    ? location.ancestorOrigins[location.ancestorOrigins.length - 1] : 'https://developnode.com';
  var last = '';
  function tellSite() {
    var msg = { type: 'dn:url', url: location.pathname + location.search + location.hash, title: document.title };
    var key = msg.url + '\n' + msg.title;
    if (key === last) return;
    last = key;
    try { window.top.postMessage(msg, site); } catch (e) {}
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); tellSite(); return r; };
  });
  window.addEventListener('popstate', tellSite);
  window.addEventListener('hashchange', tellSite);
  window.addEventListener('load', tellSite);
  var t = document.querySelector('title');
  if (t && window.MutationObserver) new MutationObserver(tellSite).observe(t, { childList: true, characterData: true, subtree: true });
  tellSite();

  // The site already shows the same splash, so ours stays hidden; the site
  // lifts its own the moment ours would have (the first session list drawn).
  var splash = document.getElementById('vn-splash');
  function tellReady() { try { window.top.postMessage({ type: 'dn:ready' }, site); } catch (e) {} }
  if (!splash || !document.body.contains(splash) || splash.classList.contains('ready')) tellReady();
  else {
    splash.style.visibility = 'hidden';
    var watchSplash = new MutationObserver(function () {
      if (!document.body.contains(splash) || splash.classList.contains('ready')) { watchSplash.disconnect(); tellReady(); }
    });
    watchSplash.observe(splash, { attributes: true });
    watchSplash.observe(document.body, { childList: true });
  }

  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.dn-lockup')) return;
    e.preventDefault();
    e.stopPropagation();
    window.top.location.href = 'https://developnode.com/';
  }, true);
})();
