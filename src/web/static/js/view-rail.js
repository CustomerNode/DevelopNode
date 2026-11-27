/* The view button on the rail: one button that opens every place to go.
 *
 * It sits among the rail's bottom icons, under the cloud (Update, Publish,
 * Sync) and above Settings, and always shows the same stacked-layers icon.  A press opens a menu in the look of the
 * Settings menu beside it:
 *
 *  - Sessions: setViewMode('sessions').
 *  - Tasks: the Workflow view on its task columns (VNFeed.setMode('tasks')).
 *  - Where agents are: the 3D file tree (js/agent-fleet.js), which is drawn
 *    over the app, so picking another view closes it first.
 *  - Needs you, under a line: the panel that slides in beside whatever view is
 *    open (js/doomscroll.js).  It is not a view, so it is marked while open
 *    and a second pick closes it.
 *
 * The view on screen has a tick.  The other views stay where they were (the
 * session list's options menu).  On a phone there is no rail: the button is
 * hidden and these entries are in the More menu beside the session counts
 * (topbar.js).
 */
(function () {
  'use strict';
  const svg = p => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  const LAYERS = svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>');
  const VIEWS = [
    ['sessions', 'Sessions', svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')],
    ['tasks', 'Tasks', svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>')],
    ['fleet', 'Where agents are', svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>')],
    ['doom', 'Needs you', svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 8 6 4-6 4Z"/>')],
  ];
  let box = null;

  function fleetOpen() { return !!(window.VNAgentFleet && window.VNAgentFleet.isOpen()); }
  function feedOpen() { try { return window.VNDoom.state().state === 'open'; } catch (_e) { return false; } }
  /** The view on screen, as one of the menu's keys ('' for any other view). */
  function current() {
    if (fleetOpen()) return 'fleet';
    const m = (typeof viewMode !== 'undefined') ? viewMode : 'sessions';
    return m === 'kanban' ? 'tasks' : m === 'sessions' ? 'sessions' : '';
  }
  function sync() {
    if (!box) return;
    const at = current(), feed = feedOpen();
    box.querySelectorAll('[data-view]').forEach(b => {
      const v = b.getAttribute('data-view'), on = v === 'doom' ? feed : v === at;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function close() { if (box) { box.classList.remove('open'); box.querySelector('.vv-trg').setAttribute('aria-expanded', 'false'); } }
  function open() { if (!box) return; sync(); box.classList.add('open'); box.querySelector('.vv-trg').setAttribute('aria-expanded', 'true'); }
  function go(view) {
    if (view === 'doom') {
      if (!window.VNDoom) return;
      if (feedOpen()) window.VNDoom.close();
      else { if (fleetOpen()) window.VNAgentFleet.close(); window.VNDoom.open(); }
    } else if (view === 'fleet') {
      if (!fleetOpen() && typeof openAgentFleet === 'function') openAgentFleet();
    } else {
      if (fleetOpen()) window.VNAgentFleet.close();
      if (typeof setViewMode !== 'function') return;
      if (view === 'tasks') { setViewMode('kanban'); if (window.VNFeed && VNFeed.setMode) VNFeed.setMode('tasks'); }
      else setViewMode('sessions');
    }
    sync();
  }
  function mount() {
    // Under the cloud buttons, above Settings: Settings' own place in the rail's order, one step earlier.
    const first = document.querySelector('header .hdr-sys');
    if (!first || document.getElementById('vn-views')) return;
    box = document.createElement('div');
    box.id = 'vn-views';
    box.innerHTML = '<button type="button" class="vv-trg" title="Views" aria-label="Views" aria-haspopup="true" aria-expanded="false">' + LAYERS + '</button>'
      + '<div class="vv-menu" role="menu">' + VIEWS.map(v => (v[0] === 'doom' ? '<div class="vv-sep"></div>' : '')
        + '<button type="button" data-view="' + v[0] + '" role="menuitemcheckbox" aria-checked="false">' + v[2] + '<span>' + v[1] + '</span></button>').join('') + '</div>';
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-view]');
      if (b) { close(); go(b.getAttribute('data-view')); return; }
      if (e.target.closest('.vv-trg')) { if (box.classList.contains('open')) close(); else open(); }
    });
    document.addEventListener('click', e => { if (box.classList.contains('open') && !e.target.closest('#vn-views')) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    first.parentNode.insertBefore(box, first);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.VNViews = { sync, go, current, open, close };
})();
