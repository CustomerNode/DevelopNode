/* The Workflow feed: one line per session, its newest summary card behind it.
 *
 * Workflow mode opens on this list when Smart termination is on: every
 * session that has a newest end-of-turn summary card (or live work) is one
 * line (title, sentence, what it wants from you), what needs you first.
 * Pressing a line draws that session's full card under it with the app's own
 * card code (last-card.js), buttons live: a reply or a verdict goes to THAT
 * session, whether or not it is the one the tab has open.  Pressing another
 * line closes the first.  Done and Standby fold behind one quiet row.
 *
 * Data: GET /api/feed?project= (src/web/routes/sessions_api.py), built from
 * the sidebar's own listing plus the cached card per transcript
 * (src/web/feed.py).  The list refreshes on the session pushes the sidebar
 * already listens to, debounced, and keeps the open card open.
 *
 * The task columns stay one tap away: the Feed | Tasks switch in the
 * Workflow sidebar (kanban.js renderKanbanSidebar) flips #feed-view and
 * #kanban-board; the choice is kept per device.  With Smart termination off
 * the view opens on the columns, since there are no cards to list.
 */
(function () {
  'use strict';
  const LS_MODE = 'vnWorkflowView';     // 'feed' | 'tasks', per device
  const REFRESH_MS = 1500;              // pushes arrive in bursts; one reload per burst
  // The verdict rows a card shows under Next, by the session's verb
  // (last-card.js _syncDone draws the same for the chat's newest card).
  const STATE = { review: 'verdict', read: 'read', send: 'send', decide: 'question', unblock: 'question', standby: 'standby', done: 'done' };

  let _items = [];
  let _open = null;          // session id of the open line
  let _shown = false;        // Workflow mode is on screen
  let _timer = null;
  let _loading = false;
  let _hooked = false;
  let _status = 0;           // last response status, for the empty states
  let _loadedFor = null;     // project the list on screen was loaded for

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const _el = () => document.getElementById('feed-view');
  const _board = () => document.getElementById('kanban-board');
  const _on = () => !!window.SessionVerb;   // Smart termination on (session-verb.js)
  function _project() {
    try { return localStorage.getItem('activeProject') || ''; } catch (_e) { return ''; }
  }

  // The views of Workflow mode, by name: the feed (this file), the queue
  // (queue.js), the agent map (agents-map.js) and the task columns
  // (kanban.js).  Each other view registers {el, show, hide}; the columns
  // are the board the app already draws.
  const VIEWS = { feed: { el: _el, show: () => { if (_loadedFor !== _project()) load(); }, hide: () => {} } };
  function register(name, view) { VIEWS[name] = view; if (_shown) apply(); }

  /** Which view of Workflow mode is open: feed, queue, agents or tasks. */
  function mode() {
    let m = '';
    try { m = localStorage.getItem(LS_MODE) || ''; } catch (_e) { /* private mode */ }
    if (m === 'tasks' || VIEWS[m]) return m;
    return _on() ? 'feed' : 'tasks';
  }
  function setMode(m) {
    try { localStorage.setItem(LS_MODE, m === 'tasks' || VIEWS[m] ? m : 'tasks'); } catch (_e) { /* private mode */ }
    apply();
  }
  function syncSwitch() {
    const m = mode();
    document.querySelectorAll('[data-wv]').forEach(b => b.classList.toggle('on', b.getAttribute('data-wv') === m));
  }

  /** Show the view that is chosen; called on entering Workflow mode and on the switch. */
  function apply() {
    const feed = _el(), board = _board();
    if (!feed || !_shown) return;
    const m = mode();
    Object.keys(VIEWS).forEach(name => {
      const v = VIEWS[name], el = typeof v.el === 'function' ? v.el() : v.el;
      if (!el) return;
      if (name === m) { el.style.display = ''; try { v.show(); } catch (_e) { /* the switch itself must never fail */ } }
      else if (el.style.display !== 'none') { el.style.display = 'none'; try { v.hide(); } catch (_e) { /* same */ } }
    });
    // Entering Workflow mode can happen twice in a row (the view fade); a
    // list already on screen for this project stays, and the pushes keep it
    // fresh (each view's show() decides that for itself).
    if (board) board.style.display = m === 'tasks' ? '' : 'none';
    syncSwitch();
  }
  function enter() { _shown = true; _hook(); apply(); }
  function leave() {
    _shown = false;
    const feed = _el();
    if (feed) { feed.style.display = 'none'; feed.innerHTML = ''; }
    _items = []; _open = null; _loadedFor = null;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    Object.keys(VIEWS).forEach(name => {
      if (name === 'feed') return;
      const v = VIEWS[name], el = typeof v.el === 'function' ? v.el() : v.el;
      if (el) el.style.display = 'none';
      try { v.hide(); } catch (_e) { /* leaving must never fail */ }
    });
  }

  async function load() {
    const feed = _el();
    if (!feed || _loading || !_shown) return;
    _loading = true;
    const project = _project();
    try {
      const r = await fetch('/api/feed?project=' + encodeURIComponent(project));
      _status = r.status;
      if (!r.ok) { _items = []; _draw(); return; }
      const d = await r.json();
      _items = Array.isArray(d.items) ? d.items : [];
      _loadedFor = project;
      _draw();
    } catch (_e) {
      _status = 0; _items = []; _draw();
    } finally {
      _loading = false;
    }
  }

  /** The line's icon: the same picture the sidebar draws for the session's
   *  status (session-verb.js: Needs you, Working, Standby, Done), never a
   *  picture of its own. */
  function _icon(it) {
    const core = window.SessionVerbCore || window.SessionVerb;
    const g = it.group === 'needs' || it.group === 'working' || it.group === 'standby' || it.group === 'done' ? it.group : 'new';
    let h = '';
    if (core) {
      if (g === 'working' && typeof core.listIconHtml === 'function') h = core.listIconHtml(it.session_id, 'working');
      else if (typeof core.iconHtml === 'function') h = core.iconHtml(g, 24);
    }
    return '<span class="vnf-ic vs-' + g + '">' + (h || '<span class="vnf-dot"></span>') + '</span>';
  }

  function _row(it) {
    const right = (it.verb === 'working' || it.verb === 'waiting') && it.eta_minutes
      ? it.label + ' · ' + it.eta_minutes + ' min' : it.label;
    return '<div class="vnf-row vs-' + esc(it.verb) + '" data-sid="' + esc(it.session_id) + '" role="button" tabindex="0" title="' + esc(it.line || it.headline || '') + '">' +
      _icon(it) + '<div class="vnf-text"><div class="vnf-ttl">' + esc(it.title || it.name) + '</div>' +
      '<div class="vnf-hl">' + esc(it.headline || it.line || it.name) + '</div></div><span class="vnf-act">' + esc(right) + '</span></div>';
  }

  function _draw() {
    const feed = _el();
    if (!feed) return;
    const main = _items.filter(i => i.group === 'needs' || i.group === 'working');
    const rest = _items.filter(i => i.group === 'done' || i.group === 'standby');
    const needs = _items.filter(i => i.group === 'needs').length;
    const working = _items.filter(i => i.group === 'working').length;
    let h = '<div class="vnf-col">';
    if (_status === 404) h += '<div class="vnf-empty">The feed is not available yet: the web server has not been restarted since it was added.</div>';
    else if (!_on()) h += '<div class="vnf-empty">Summary cards come from Smart termination (System → Preferences). With it on, every session ends on a card and shows up here.</div>';
    else if (_status === 0) h += '<div class="vnf-empty">Could not load the feed.</div>';
    else if (!_items.length) h += '<div class="vnf-empty">Nothing needs you.</div>';
    else h += '<div class="vnf-quiet"><b>' + needs + ' need you</b><span>' + working + ' working</span></div>';
    main.forEach((it, i) => {
      h += _row(it) + '<div class="vnf-open"></div>';
      if (i < main.length - 1) h += '<div class="vnf-sep"></div>';
    });
    if (rest.length) {
      h += '<div class="vnf-fold" data-fold role="button" tabindex="0">' + rest.length + ' done or on standby ▾</div>' +
        '<div class="vnf-folded" hidden>' + rest.map(it => _row(it) + '<div class="vnf-open"></div>').join('') + '</div>';
    }
    h += '</div>';
    feed.innerHTML = h;
    if (_open) {
      const row = feed.querySelector('.vnf-row[data-sid="' + CSS.escape(_open) + '"]');
      if (row) _openRow(row, false); else _open = null;
    }
  }

  /** Draw the session's full card under its line (the real card code), and
   *  the verdict rows its verb calls for, the way the chat's newest card gets them. */
  function _openRow(row, toggle) {
    const feed = _el();
    const sid = row.getAttribute('data-sid');
    const holder = row.nextElementSibling && row.nextElementSibling.classList.contains('vnf-open') ? row.nextElementSibling : null;
    const was = row.classList.contains('open');
    feed.querySelectorAll('.vnf-row.open').forEach(r => {
      r.classList.remove('open');
      const hh = r.nextElementSibling;
      if (hh && hh.classList.contains('vnf-open')) hh.innerHTML = '';
    });
    if (was && toggle) { _open = null; return; }
    const it = _items.find(x => x.session_id === sid);
    row.classList.add('open');
    _open = sid;
    if (!holder || !it) return;
    const thread = '<div class="vnf-thread"><a href="#" data-thread="' + esc(sid) + '">Open the session ›</a></div>';
    if (!it.card) {
      holder.innerHTML = '<div class="vnf-nocard">' + (it.group === 'working' ? 'Working; its summary comes when it stops.' : 'No summary yet.') +
        ' <a href="#" data-thread="' + esc(sid) + '">Open the session ›</a></div>';
      return;
    }
    cardInto(holder, it);
    holder.insertAdjacentHTML('beforeend', thread);
  }

  /** Draw a feed item's summary card into *holder* with the app's own card
   *  code, plus the verdict rows its verb calls for.  Shared with the queue
   *  and the agent map, which show the same cards. */
  function cardInto(holder, it) {
    const sid = it.session_id || '';
    holder.innerHTML = '<div class="msg assistant vnf-msg" data-sid="' + esc(sid) + '" data-ts="' + Math.round(Number(it.ts) || 0) + '">' +
      '<div class="msg-body"><div class="vn-card-ph" data-card="' + esc(JSON.stringify(it.card || {})) + '"></div></div></div>';
    if (window.VNLastCard && typeof VNLastCard.renderIn === 'function') {
      try { VNLastCard.renderIn(holder); } catch (_e) { /* the line stays usable */ }
    }
    const fin = holder.querySelector('.lm-finish');
    if (fin) {
      const st = STATE[it.verb] || '';
      fin.hidden = !st;
      if (st) { fin.dataset.state = st; fin.classList.toggle('done', it.verb === 'done'); }
    }
  }

  function _openSession(sid) {
    if (typeof setViewMode === 'function') setViewMode('sessions');
    setTimeout(() => { if (typeof openInGUI === 'function') openInGUI(sid); }, 160);
  }

  function _bump() {
    if (!_shown || mode() !== 'feed') return;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => { _timer = null; load(); }, REFRESH_MS);
  }
  function _hook() {
    if (_hooked || typeof socket === 'undefined' || !socket || typeof socket.on !== 'function') return;
    _hooked = true;
    ['session_state', 'session_entry', 'session_hold', 'session_renamed', 'sessions_refresh', 'session_started'].forEach(ev => socket.on(ev, _bump));
  }

  document.addEventListener('click', e => {
    const feed = _el();
    if (!feed || !feed.contains(e.target)) return;
    const a = e.target.closest('[data-thread]');
    if (a) { e.preventDefault(); _openSession(a.getAttribute('data-thread')); return; }
    const fold = e.target.closest('[data-fold]');
    if (fold) {
      const list = fold.nextElementSibling;
      if (list) { list.hidden = !list.hidden; fold.textContent = fold.textContent.replace(/[▾▴]$/, () => (list.hidden ? '▾' : '▴')); }
      return;
    }
    const row = e.target.closest('.vnf-row');
    if (row) _openRow(row, true);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest && e.target.closest('.vnf-row');
    if (row && _el() && _el().contains(row)) { e.preventDefault(); _openRow(row, true); }
  });
  // Another tab (or device, through the config re-read) flipped Smart
  // termination: the default half changes with it.
  window.addEventListener('storage', e => { if (e.key === 'vnSmartTermination' || e.key === LS_MODE) apply(); });

  window.VNFeed = { enter, leave, apply, load, mode, setMode, syncSwitch, register, cardInto, iconFor: _icon, openSession: _openSession, _items: () => _items };
})();
