/* DevelopNode on a phone (css/mobile-hairline.css): the navigation bar with its ••• menu, status tabs above the
 * session boxes, the large title folding into the bar as the boxes scroll, and one ••• menu (no tab bar at the bottom).  Every control calls the app's own function (filters, Sync, the System menu, the
 * theme, New Session), so nothing here keeps state of its own.  Phone widths only; ?finish=classic turns it off.
 */
(function () {
  'use strict';

  var MQ = window.matchMedia('(max-width: 768px)');
  var classic = document.documentElement.getAttribute('data-finish') === 'classic';

  var SVG = function (d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  };
  var ICON = {
    sessions: SVG('<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>'),
    sync: SVG('<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1 .5 7.97"/><path d="M12 12v8M9 15l3-3 3 3"/>'),
    settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    search: SVG('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/>'),
    newc: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M12 7v10M7 12h10" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
    more: SVG('<circle cx="12" cy="12" r="9.5"/><circle cx="7.6" cy="12" r=".9" fill="currentColor"/><circle cx="12" cy="12" r=".9" fill="currentColor"/><circle cx="16.4" cy="12" r=".9" fill="currentColor"/>'),
    filter: SVG('<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>'),
    list: SVG('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
    folder: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    moon: SVG('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'),
    sun: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    plus: SVG('<path d="M12 5v14M5 12h14"/>').replace('stroke-width="1.8"', 'stroke-width="2.2"')
  };

  // Status tab -> the funnel filter it stands for (app.js toggleSessionFilter); null is "All".
  var CHIPS = [
    { key: null, label: 'All' },
    { key: 'needs', bucket: 'question', label: 'Needs you', color: 'var(--mh-needs)' },
    { key: 'working', bucket: 'working', label: 'Working', color: 'var(--mh-acc)' },
    { key: 'sleeping', bucket: 'sleeping', label: 'Done', color: 'var(--mh-done)' }
  ];
  var STATE_KEYS = ['needs', 'working', 'standby', 'sleeping'];

  function active() {
    try { return (typeof _activeSessionFilters === 'function') ? _activeSessionFilters() : new Set(); } catch (e) { return new Set(); }
  }
  function sessions() {
    try { return (typeof allSessions !== 'undefined' && Array.isArray(allSessions)) ? allSessions : []; } catch (e) { return []; }
  }
  function bucketOf(s) {
    try {
      if (window.SessionVerb && SessionVerb.filterBucket) return SessionVerb.filterBucket(s.id);
      if (typeof getSessionStatus === 'function') return getSessionStatus(s.id);
    } catch (e) { /* fall through */ }
    return '';
  }

  function pickChip(key) {
    if (typeof toggleSessionFilter !== 'function') return;
    var cur = active();
    STATE_KEYS.forEach(function (k) { if (k !== key && cur.has(k)) toggleSessionFilter(k); });
    if (key && !active().has(key)) toggleSessionFilter(key);
    paintChips();
  }

  var chipsEl = null, barEl = null;

  function paintChips() {
    if (!chipsEl) return;
    var filterWrap = document.getElementById('sidebar-filter-wrap');
    chipsEl.hidden = !!(filterWrap && filterWrap.hidden);
    var counts = {}; sessions().forEach(function (s) { var b = bucketOf(s); counts[b] = (counts[b] || 0) + 1; });
    var cur = active(), on = STATE_KEYS.filter(function (k) { return cur.has(k); });
    var current = on.length === 1 ? on[0] : (on.length ? 'mixed' : null);
    var html = '';
    CHIPS.forEach(function (c) {
      var n = c.key ? (counts[c.bucket] || 0) : sessions().length;
      html += '<button type="button" class="vn-mh-seg' + (current === c.key ? ' on' : '') + '" data-chip="' + (c.key || '') + '">' +
        c.label + '<i' + (n ? ' class="has"' : '') + '>' + n + '</i></button>';
    });
    if (chipsEl.innerHTML !== html) chipsEl.innerHTML = html;
  }

  function paintBar() {
    var hdr = document.querySelector('header');
    var nudge = hdr && hdr.getAttribute('data-git-nudge');
    if (barEl) barEl.querySelector('[data-tab="sync"]').classList.toggle('has-badge', !!nudge && nudge !== '0');
    if (navTitle) {   // the label's own text, without its hidden "project" caption
      var pl = document.getElementById('project-label'), t = '';
      if (pl) pl.childNodes.forEach(function (n) { if (n.nodeType === 3) t += n.textContent; });
      navTitle.textContent = t.trim();
    }
    if (menuEl) {
      var light = document.documentElement.getAttribute('data-theme') === 'light';
      var ap = menuEl.querySelector('[data-act="theme"]');
      if (ap) ap.innerHTML = 'Appearance: ' + (light ? 'Light' : 'Dark') + (light ? ICON.sun : ICON.moon);
    }
  }

  var navEl = null, navTitle = null, menuEl = null, scrimEl = null;
  function closeMenu() { if (menuEl) menuEl.classList.remove('open'); if (scrimEl) scrimEl.classList.remove('open'); }
  // The funnel's and the ••• menu's own dropdowns hang under the search field, so unfold first to show them.
  function clickHidden(id) {
    var sb = document.querySelector('.sidebar'), g = document.getElementById('workforce-grid');
    if (g) g.scrollTop = 0; if (sb) sb.classList.remove('vn-mh-folded');
    var b = document.getElementById(id); if (b) b.click();
  }

  function fold(sb) {
    var sc = [document.getElementById('workforce-grid'), document.getElementById('session-list')];
    var top = 0; sc.forEach(function (el) { if (el && el.offsetParent !== null) top = Math.max(top, el.scrollTop); });
    sb.classList.toggle('vn-mh-folded', top > 8);
  }

  function build() {
    var sb = document.querySelector('.sidebar');
    var head = sb && sb.querySelector('.sidebar-header');
    if (!sb || !head) return false;
    if (!navEl) {
      navEl = document.createElement('div');
      navEl.className = 'vn-mh-nav';
      navEl.innerHTML = '<button type="button" class="vn-mh-navtitle" aria-label="Switch project"></button><button type="button" class="vn-mh-more" aria-label="More" title="More">' + ICON.more + '</button>';
      navTitle = navEl.querySelector('.vn-mh-navtitle');
      // Folded, the project name lives in the bar; it switches project there too.
      navTitle.addEventListener('click', function (e) { e.stopPropagation(); if (typeof openProjectOverlay === 'function') openProjectOverlay(); });
      head.insertBefore(navEl, head.firstChild);
      scrimEl = document.createElement('div'); scrimEl.className = 'vn-mh-scrim';
      menuEl = document.createElement('div'); menuEl.className = 'vn-mh-menu'; menuEl.setAttribute('role', 'menu');
      menuEl.innerHTML =
        '<button type="button" data-act="new">New session' + ICON.plus + '</button>' +
        '<button type="button" data-act="filter" class="gap">Filter sessions' + ICON.filter + '</button>' +
        '<button type="button" data-act="actions">Session actions' + ICON.list + '</button>' +
        '<button type="button" data-act="project" class="gap">Switch project' + ICON.folder + '</button>' +
        '<button type="button" data-act="theme">Appearance' + ICON.moon + '</button>' +
        '<button type="button" data-act="sync" class="gap">Sync' + ICON.sync + '</button>' +
        '<button type="button" data-act="settings">Settings' + ICON.settings + '</button>';
      sb.appendChild(scrimEl); sb.appendChild(menuEl);
      navEl.querySelector('.vn-mh-more').addEventListener('click', function (e) { e.stopPropagation(); menuEl.classList.add('open'); scrimEl.classList.add('open'); paintBar(); });
      scrimEl.addEventListener('click', closeMenu);
      menuEl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]'); if (!b) return;
        e.stopPropagation(); closeMenu();
        var a = b.dataset.act;
        if (a === 'filter') setTimeout(function () { clickHidden('sidebar-filter-btn'); }, 0);
        else if (a === 'actions') setTimeout(function () { clickHidden('sidebar-menu-btn'); }, 0);
        else if (a === 'project') { if (typeof openProjectOverlay === 'function') openProjectOverlay(); }
        else if (a === 'new') { var nb = document.getElementById('btn-add-agent'); if (nb) nb.click(); else if (typeof addNewAgent === 'function') addNewAgent(); }
        else if (a === 'sync') { if (typeof openGitSyncBoth === 'function') openGitSyncBoth(); }
        else if (a === 'settings') { if (typeof toggleHdrSys === 'function') toggleHdrSys(); }
        else if (a === 'theme') { if (typeof cycleTheme === 'function') cycleTheme(); setTimeout(paintBar, 0); }
      });
      var onScroll = function () { fold(sb); };
      ['workforce-grid', 'session-list'].forEach(function (id) { var el = document.getElementById(id); if (el) el.addEventListener('scroll', onScroll, { passive: true }); });
    }
    if (!chipsEl) {
      chipsEl = document.createElement('div');
      chipsEl.className = 'vn-mh-tabs';
      chipsEl.setAttribute('role', 'group');
      chipsEl.setAttribute('aria-label', 'Show sessions');
      chipsEl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-chip]'); if (!b) return;
        pickChip(b.dataset.chip || null);
      });
      head.appendChild(chipsEl);
    }
    if (false) {   // no bottom tab bar on the phone: one menu (the ••• menu) holds New session, Sync and Settings
      barEl = document.createElement('nav');
      barEl.className = 'vn-mh-bar';
      barEl.setAttribute('aria-label', 'DevelopNode');
      barEl.innerHTML =
        '<button type="button" class="vn-mh-tab on" data-tab="sessions">' + ICON.sessions + '<span>Sessions</span></button>' +
        '<button type="button" class="vn-mh-tab" data-tab="sync">' + ICON.sync + '<span class="badge"></span><span>Sync</span></button>' +
        '<button type="button" class="vn-mh-tab new" data-tab="new" title="New Session">' + ICON.newc + '<span>New</span></button>' +
        '<button type="button" class="vn-mh-tab" data-tab="search">' + ICON.search + '<span>Search</span></button>' +
        '<button type="button" class="vn-mh-tab" data-tab="settings">' + ICON.settings + '<span>Settings</span></button>';
      barEl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-tab]'); if (!b) return;
        e.stopPropagation();
        var t = b.dataset.tab;
        if (t === 'sessions') {
          if (typeof setViewMode === 'function' && typeof viewMode !== 'undefined' && viewMode === 'homepage') setViewMode('sessions');
          var g = document.getElementById('workforce-grid'); if (g && g.scrollTo) g.scrollTo({ top: 0, behavior: 'smooth' });
        }
        else if (t === 'search') { var sbtn = document.querySelector('.sidebar-search-btn'); if (sbtn) sbtn.click(); }
        else if (t === 'sync') { if (typeof openGitSyncBoth === 'function') openGitSyncBoth(); }
        else if (t === 'new') { var nb = document.getElementById('btn-add-agent'); if (nb) nb.click(); else if (typeof addNewAgent === 'function') addNewAgent(); }
        else if (t === 'settings') { if (typeof toggleHdrSys === 'function') toggleHdrSys(); }
      });
      sb.appendChild(barEl);
    }
    paintChips(); paintBar();
    return true;
  }

  // ── Project picker as a bottom sheet (css/mobile-hairline.css): swipe a project left for Rename / Delete,
  // tap elsewhere to put it back; Done or the backdrop slides the sheet down; drag the handle down to close.
  var sheetWired = false;
  function wireProjectSheet() {
    if (sheetWired) return; sheetWired = true;
    var ov = document.getElementById('project-overlay'), list = document.getElementById('project-list');
    if (!ov || !list) return;
    var on = function () { return document.documentElement.classList.contains('vn-mhl'); };
    var unswipe = function (except) { list.querySelectorAll('.mh-swiped').forEach(function (r) { if (r !== except) r.classList.remove('mh-swiped'); }); };
    var x0 = null, y0 = null, row = null;
    list.addEventListener('pointerdown', function (e) {
      if (!on()) return;
      row = e.target.closest('.project-item:not(.project-item-all):not(.project-item-add)'); x0 = e.clientX; y0 = e.clientY;
    });
    list.addEventListener('pointerup', function (e) {
      // Edit order: no swipe for Rename / Delete while projects are being moved.
      if (!on() || x0 === null || list.classList.contains('editing')) { x0 = null; return; }
      // The list can be redrawn mid-swipe (a fresh project list arrives); find the same project again.
      if (row && !row.isConnected && row.dataset.encoded && window.CSS && CSS.escape) row = list.querySelector('.project-item[data-encoded="' + CSS.escape(row.dataset.encoded) + '"]');
      var dx = e.clientX - x0, dy = Math.abs(e.clientY - y0);
      if (row && dx < -30 && dy < 30) { unswipe(row); row.classList.add('mh-swiped'); list.dataset.mhSwipeAt = String(Date.now()); }
      else if (row && dx > 30 && row.classList.contains('mh-swiped')) { row.classList.remove('mh-swiped'); list.dataset.mhSwipeAt = String(Date.now()); }
      x0 = null;
    });
    // A tap right after a swipe, or on a row whose actions are showing, only closes the actions.
    list.addEventListener('click', function (e) {
      if (!on()) return;
      if (Date.now() - (+list.dataset.mhSwipeAt || 0) < 350) { e.stopPropagation(); e.preventDefault(); return; }
      if (e.target.closest('.project-item-actions')) return;
      var open = list.querySelector('.mh-swiped');
      if (open) { e.stopPropagation(); e.preventDefault(); unswipe(); }
    }, true);
    // The swipe hint shows under the projects, not while another feature asks which project.
    var hint = function () { list.classList.toggle('mh-hint', on() && !!list.querySelector('.project-item-actions')); };
    new MutationObserver(hint).observe(list, { childList: true });
    // Slide the sheet down before the app hides it.
    var orig = window.closeProjectOverlay;
    if (typeof orig === 'function') {
      window.closeProjectOverlay = function () {
        var args = arguments;
        if (!on() || !ov.classList.contains('show')) return orig.apply(this, args);
        unswipe(); ov.classList.add('mh-closing');
        setTimeout(function () { ov.classList.remove('mh-closing'); orig.apply(window, args); }, 250);
      };
    }
    // Drag the handle or the header down to close.
    var card = document.getElementById('project-card'), hy = null;
    if (card) {
      card.addEventListener('pointerdown', function (e) { if (on() && e.clientY - card.getBoundingClientRect().top < 64) hy = e.clientY; });
      card.addEventListener('pointerup', function (e) { if (hy !== null && e.clientY - hy > 60 && window.closeProjectOverlay) window.closeProjectOverlay(); hy = null; });
    }
  }

  function apply() {
    var on = MQ.matches && !classic;
    document.documentElement.classList.toggle('vn-mhl', on);
    // The chat uses the desktop look's own surfaces (hairline.css, quiet-chat.css): its layout rules are limited
    // to desktop widths, so on the phone only the surfaces apply.  index.html leaves the phone without it.
    if (on && !document.documentElement.getAttribute('data-finish')) document.documentElement.setAttribute('data-finish', 'hairline');
    // The list's top is the desktop's left menu (js/topbar.js), so only the project sheet is built here.
    if (on) { wireProjectSheet(); }
  }

  function start() {
    apply();
    if (MQ.addEventListener) MQ.addEventListener('change', apply); else if (MQ.addListener) MQ.addListener(apply);
    // Counts and the chosen chip follow every repaint of the list; the badge and theme icon follow their attributes.
    var grid = document.getElementById('workforce-grid'), list = document.getElementById('session-list');
    var pending = 0;
    var later = function () { if (pending) return; pending = requestAnimationFrame(function () { pending = 0; if (MQ.matches && !classic) paintChips(); }); };
    var mo = new MutationObserver(later);
    if (grid) mo.observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    if (list) mo.observe(list, { childList: true });
    var fw = document.getElementById('sidebar-filter-wrap');
    if (fw) mo.observe(fw, { attributes: true, attributeFilter: ['hidden'] });
    var hdr = document.querySelector('header');
    var mo2 = new MutationObserver(function () { if (MQ.matches && !classic) paintBar(); });
    if (hdr) mo2.observe(hdr, { attributes: true, attributeFilter: ['data-git-nudge'] });
    var pl = document.getElementById('project-label');
    if (pl) mo2.observe(pl, { childList: true, characterData: true, subtree: true });
    mo2.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.VNMobileHairline = { apply: apply, paintChips: paintChips };
})();
