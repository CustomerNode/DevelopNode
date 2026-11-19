// Desktop layout of the session controls (hairline finish, wider than 768px).
//
//  - Top bar, across the session list and the chat: the open session's title over the chat column, then its
//    ••• and close at the right.  It replaces the strip above an open session.
//  - Project masthead at the top of the session list: the project name as a heading, with Search, filter and
//    sort/display on the same line.  It replaces the sidebar's header rows.
//  - Session counts: a footer under the list, each status as the tiles' own icon and its number.
//  - New session: a dashed full-width row under the masthead, above the session tiles.
//
// Every control is the app's own, moved in, not a copy: ids, onclick, hidden attributes and inline display other
// code sets on them keep working (the filter dot, the views that hide Search or New session, toolbar.js showing
// and hiding #main-toolbar, _updateProjectLabel).  #main-toolbar is shown with display: contents inside the bar.
// Each moved control leaves a marker where it lived and goes back there at phone width or another finish.
(function () {
  'use strict';
  var mq = window.matchMedia('(min-width: 769px)');
  var bar = null, mast = null, pill = null, counts = null, moved = [], timer = null;

  // The session tiles' own status marks (session-verb.js GLYPH / the pickaxe picture with its colour filter).
  var LABEL = { needs: 'Needs you', working: 'Working', standby: 'Standby', done: 'Done' };
  var _svg = function (g) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + g + '</svg>'; };
  var ICON = {
    needs: _svg('<circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>'),
    working: '<img src="/static/svg/pickaxe.svg" alt="" style="filter:brightness(0) saturate(100%) invert(55%) sepia(78%) saturate(1000%) hue-rotate(215deg)">',
    standby: _svg('<circle cx="12" cy="12" r="9.5"/><path d="M10 9v6"/><path d="M14 9v6"/>'),
    done: _svg('<circle cx="12" cy="12" r="9.5"/><polyline points="16.5 9 10.5 15 7.5 12"/>'),
  };

  // The left menu (masthead, New Session row, counts) is used at every width; the top bar over the chat only on a
  // desktop.  On a phone (html.vn-tb-phone) the session keeps its own strip, and the rail's Sync, Settings and
  // Appearance sit at the left of the counts, where the rail's bottom icons sit on a desktop.
  var mode = '';
  function wanted() {
    return document.documentElement.getAttribute('data-finish') === 'hairline' ? (mq.matches ? 'desk' : 'phone') : '';
  }

  function build() {
    bar = document.createElement('div');
    bar.className = 'vn-topbar';
    bar.id = 'vn-topbar';
    bar.setAttribute('role', 'toolbar');
    var layout = document.querySelector('.layout');
    (layout ? layout.parentNode : document.body).insertBefore(bar, layout);

    mast = document.createElement('div');
    mast.className = 'vn-mast';
    mast.innerHTML = '<div class="vn-mast-row vn-mast-top"><span class="vn-mast-gap"></span></div>';

    counts = document.createElement('div');
    counts.className = 'vn-foot-counts';
    counts.setAttribute('aria-label', 'Sessions by status');
    counts.innerHTML = ['needs', 'working', 'standby', 'done'].map(function (k) {
      return '<span class="vn-ct ' + k + '" data-ct="' + k + '" role="button" tabindex="0" aria-pressed="false" title="Show only ' + LABEL[k] +
        '"><span class="vn-ct-ic">' + ICON[k] + '</span><b>-</b></span>';
    }).join('');
    // Each count is a filter (the funnel's own status chips, app.js toggleSessionFilter): several may be on;
    // turning the last one off shows every session again.
    var pick = function (e) {
      var ct = e.target.closest && e.target.closest('.vn-ct[data-ct]');
      if (!ct || typeof window.toggleSessionFilter !== 'function') return;
      e.preventDefault();
      window.toggleSessionFilter(CHIP[ct.dataset.ct]);
      syncCountFilters();
    };
    counts.addEventListener('click', pick);
    counts.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') pick(e); });

    pill = document.createElement('div');
    pill.className = 'vn-new-row';
  }

  // [selector, where it goes]
  function parts() {
    var top = mast.querySelector('.vn-mast-top'), gap = mast.querySelector('.vn-mast-gap');
    return [
      ['#btn-project', function (n) { top.insertBefore(n, gap); }],
      ['.sidebar-search-btn', function (n) { top.appendChild(n); }],
      ['#sidebar-filter-wrap', function (n) { top.appendChild(n); }],
      ['.sidebar-menu-wrap', function (n) { top.appendChild(n); }],
      ['#btn-add-agent', function (n) { if (mode === 'phone') top.appendChild(n); else pill.appendChild(n); }],
    ].concat(mode === 'phone' ? [] : [['#main-toolbar', function (n) { bar.appendChild(n); }]]);
  }

  function mount() {
    if (moved.length) return;
    var sidebar = document.querySelector('.sidebar'), head = document.querySelector('.sidebar-header');
    if (!sidebar) return;
    if (!bar) build();
    sidebar.insertBefore(mast, head ? head.nextSibling : sidebar.firstChild);
    if (mode !== 'phone') sidebar.insertBefore(pill, mast.nextSibling);
    sidebar.appendChild(counts);
    parts().forEach(function (p) {
      var node = document.querySelector(p[0]);
      if (!node || bar.contains(node) || mast.contains(node) || pill.contains(node) || (mode === 'phone' && node.closest && node.closest('.vn-mast'))) return;
      var mark = document.createComment('vn-topbar: ' + p[0]);
      node.parentNode.insertBefore(mark, node);
      moved.push({ node: node, mark: mark });
      p[1](node);
    });
    document.documentElement.classList.add('vn-has-topbar');
    document.documentElement.classList.toggle('vn-tb-phone', mode === 'phone');
    if (mode === 'phone') phoneRail(); else if (rail && rail.parentNode) rail.parentNode.removeChild(rail);
    refreshCounts();
    timer = setInterval(function () { if (!document.hidden) refreshCounts(); }, 4000);
  }

  function unmount() {
    if (!moved.length) return;
    moved.forEach(function (r) {
      if (r.mark.parentNode) r.mark.parentNode.replaceChild(r.node, r.mark);
    });
    moved = [];
    if (mast && mast.parentNode) mast.parentNode.removeChild(mast);
    if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
    if (counts && counts.parentNode) counts.parentNode.removeChild(counts);
    clearInterval(timer); timer = null;
    document.documentElement.classList.remove('vn-has-topbar', 'vn-tb-phone');
    if (rail && rail.parentNode) rail.parentNode.removeChild(rail);
  }

  // Phone: one ••• button left of the counts.  Its menu holds everything else from the desktop's left menu and rail
  // (Search, Filter, Sort and display, Sync, Settings, Appearance), each calling the app's own function; Filter and
  // Sort open as the app's own phone sheets.  The masthead keeps only the project and New Session.
  var rail = null;
  var MORE_ICON = _svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>');
  var ITEMS = [
    ['search', 'Search', function () { if (typeof openDeepSearch === 'function') openDeepSearch(); }],
    ['filter', 'Filter sessions', function () { if (typeof toggleFilterMenu === 'function') toggleFilterMenu(); }],
    ['sort', 'Sort and display', function () { if (typeof toggleSidebarMenu === 'function') toggleSidebarMenu(); }],
    ['sync', 'Sync', function () { if (typeof openGitSyncBoth === 'function') openGitSyncBoth(); }],
    ['doom', 'Needs you', function () { if (window.VNDoom) VNDoom.open(); }],
    ['settings', 'Settings', function () { if (typeof toggleHdrSys === 'function') toggleHdrSys(); }],
    ['theme', 'Appearance', function () { if (typeof cycleTheme === 'function') cycleTheme(); }]
  ];
  var ICONS = {
    search: _svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/>'),
    filter: _svg('<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>'),
    sort: _svg('<path d="M4 7h9M18 7h2M4 17h2M11 17h9"/><circle cx="15.5" cy="7" r="2.5"/><circle cx="8.5" cy="17" r="2.5"/>'),
    sync: _svg('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1 .5 7.97"/><path d="M12 12v8M9 15l3-3 3 3"/>'),
    doom: _svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 8 6 4-6 4Z"/>'),
    settings: _svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>'),
    theme: _svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>')
  };
  function closeMore() { if (rail) rail.classList.remove('open'); }
  function phoneRail() {
    if (!rail) {
      rail = document.createElement('div');
      rail.className = 'vn-foot-rail';
      rail.innerHTML = '<button type="button" class="vn-more-btn" aria-label="More" aria-haspopup="true">' + MORE_ICON + '</button>' +
        '<div class="vn-more-pop" role="menu">' + ITEMS.map(function (it) {
          return '<button type="button" role="menuitem" data-item="' + it[0] + '">' + (ICONS[it[0]] || '') + it[1] + '</button>';
        }).join('') + '</div>';
      rail.addEventListener('click', function (e) {
        e.stopPropagation();
        if (e.target.closest('.vn-more-btn')) {
          var fw = document.getElementById('sidebar-filter-wrap'), sb = document.querySelector('.vn-mast .sidebar-search-btn');
          rail.querySelector('[data-item="filter"]').hidden = !!(fw && fw.hidden);
          rail.querySelector('[data-item="search"]').hidden = !!(sb && sb.style.display === 'none');
          // The app's own phone sheet, the one Filter and Sort open as (sessions.js _menuToSheet)
          if (typeof window._menuToSheet === 'function') window._menuToSheet(rail.querySelector('.vn-more-pop'));
          else rail.classList.toggle('open');
          return;
        }
        var b = e.target.closest('[data-item]'); if (!b) return;
        closeMore();
        ITEMS.forEach(function (it) { if (it[0] === b.dataset.item) setTimeout(it[2], 0); });
      });
      document.addEventListener('click', closeMore);
    }
    if (counts && rail.parentNode !== counts) counts.insertBefore(rail, counts.firstChild);
  }

  // The counts are the homepage's own (_hpThree in toolbar.js): what the session list draws, grouped.
  function refreshCounts() {
    if (!counts || typeof window._hpThree !== 'function') return;
    var c;
    try { c = window._hpThree(typeof _waitingPolledOnce !== 'undefined' ? _waitingPolledOnce : true); } catch (_e) { return; }
    var set = function (cls, v) { var b = counts.querySelector('.' + cls + ' b'); if (b && b.textContent !== String(v)) b.textContent = v; };
    // A New session counts under Needs you, as the Needs-you filter shows it (session-verb.js filterBucket).
    var needs = (typeof c.needs === 'number' && c.new) ? c.needs + c.new : c.needs;
    set('needs', needs); set('working', c.working); set('standby', c.standby); set('done', c.done);
    syncCountFilters();
  }

  // Light the counts whose filter is on; while any is, the others go quiet.
  var CHIP = { needs: 'needs', working: 'working', standby: 'standby', done: 'sleeping' };
  function syncCountFilters() {
    if (!counts || typeof window._activeSessionFilters !== 'function') return;
    var cur; try { cur = window._activeSessionFilters(); } catch (_e) { return; }
    var any = false;
    counts.querySelectorAll('.vn-ct[data-ct]').forEach(function (b) {
      var on = cur.has(CHIP[b.dataset.ct]);
      if (on) any = true;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = (on ? 'Showing only this · click to stop' : 'Show only ') + (on ? '' : LABEL[b.dataset.ct]);
    });
    counts.classList.toggle('filtering', any);
  }

  // The bar spans the chat panel; the session title starts on the chat column's left edge
  // (the same column rule the strip above a session used: max(14px, (width - 766px) / 2) into the chat panel).
  function place() {
    if (!moved.length || mode === 'phone') return;
    var root = document.documentElement.style, layout = document.querySelector('.layout'), main = document.getElementById('main-panel');
    if (!layout || !main) return;
    var m = main.getBoundingClientRect();
    root.setProperty('--vn-tb-left', Math.round(m.left) + 'px');
    var x = Math.max(14, (m.width - 766) / 2);
    root.setProperty('--vn-tb-title-x', Math.round(x) + 'px');
    // ••• and close end on the chat column's right edge: the messages run 760px from 2px left of the title.
    // The close glyph sits 9px inside its 32px button, so the button reaches 9px past that edge.
    // Measured from a message when one is on screen; otherwise the column rule (14px each side, plus the log's
    // 6px scrollbar and 4px of its own padding on the right when the window is narrow).
    var msg = document.querySelector('#live-log .msg'), mr = msg && msg.getBoundingClientRect(), colRight;
    if (mr && mr.width) { colRight = mr.right - m.left; root.setProperty('--vn-tb-title-x', Math.round(mr.left - m.left) + 'px'); }
    else colRight = Math.min(m.width - 24, x - 2 + 760);
    root.setProperty('--vn-tb-right', Math.max(4, Math.round(m.width - colRight - 9)) + 'px');
  }

  function sync() {
    var w = wanted();
    if (w !== mode) { unmount(); mode = w; }
    if (mode) mount(); else unmount();
    place();
  }

  function start() {
    sync();
    if (mq.addEventListener) mq.addEventListener('change', sync); else if (mq.addListener) mq.addListener(sync);
    new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-finish'] });
    window.addEventListener('resize', place);
    var main = document.getElementById('main-panel');
    if (main && window.ResizeObserver) new ResizeObserver(place).observe(main);   // the sidebar's drag handle moves it
    // a session opening or its first messages arriving can change the measured column; at most once a frame
    var queued = false, later = function () { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; place(); }); };
    // (the messages render a moment after the title changes, so measure again shortly after as well)
    var soon = function () { later(); setTimeout(later, 300); setTimeout(later, 1200); };
    var title = document.getElementById('main-title'), tb = document.getElementById('main-toolbar');
    if (title) new MutationObserver(soon).observe(title, { childList: true, characterData: true, subtree: true });
    if (tb) new MutationObserver(soon).observe(tb, { attributes: true, attributeFilter: ['style'] });
    if (window.SessionStore && typeof SessionStore.subscribe === 'function') {
      var t = null;
      SessionStore.subscribe(function () { clearTimeout(t); t = setTimeout(refreshCounts, 250); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.VNTopbar = { sync: sync, refreshCounts: refreshCounts, syncCountFilters: syncCountFilters };
})();
