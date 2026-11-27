/* Needs-you reel: every session that needs you, one per screen, in a panel
 * that comes out from the right.
 *
 * Opened from the Needs you entry of the view button on the rail (desktop,
 * view-rail.js) or of the phone's ••• menu (topbar.js).  The panel pushes
 * the app left to make room, so nothing is covered and the app stays usable.
 * Full screen covers everything; minimize tucks it into a small tab on the
 * right edge with the count; the X closes it.  The size is kept per device.
 *
 * Each screen is one session: its summary's first picture across the top (a
 * drawn tile from its status and path when it has none), its status, title,
 * sentence and short answer, and its own answer buttons as pills.  The real
 * summary card is drawn hidden in the screen: a pill presses the card's own
 * button, so an answer goes exactly where the card would send it, and Summary
 * slides that same card up as a sheet.  Scroll, swipe or the arrow keys snap
 * from one session to the next.
 *
 * Data is the Workflow feed's own: GET /api/feed?project= for the items
 * (src/web/routes/sessions_api.py) and VNFeed.cardInto (feed.js) for the
 * card.  The list refreshes on the session pushes the sidebar already listens
 * to, only while the panel is open, and is redrawn only when it changed, so a
 * reader keeps their place.  A link with ?needsyou=1 opens the app with it out.
 */
(function () {
  'use strict';
  if (window.VNDoom) return;               // loaded once per page
  const LS = 'vnDoomSize';                 // 'drawer' | 'full', per device
  const REFRESH_MS = 1200;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const _svg = g => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + g + '</svg>';
  const ICON = {
    rail: _svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 8 6 4-6 4Z"/>'),   // play square: the reel
    full: _svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
    restore: _svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
    min: _svg('<path d="M5 18h14"/>'),
    close: _svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    sheet: _svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
    open: _svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'),
    down: _svg('<path d="m6 9 6 6 6-6"/>')
  };

  let panel = null, tab = null;
  let size = 'drawer', state = 'closed';   // state: closed | open | min
  let items = [], sig = '', timer = null, hooked = false, loading = false, status = 200;

  try { size = localStorage.getItem(LS) === 'full' ? 'full' : 'drawer'; } catch (_e) { /* private mode */ }
  const project = () => { try { return localStorage.getItem('activeProject') || ''; } catch (_e) { return ''; } };
  const iconFor = it => (window.VNFeed && VNFeed.iconFor ? VNFeed.iconFor(it) : '');

  function build() {
    if (panel) return;
    panel = document.createElement('aside');
    panel.className = 'vn-doom';
    panel.id = 'vn-doom';
    panel.setAttribute('aria-label', 'Needs you');
    panel.innerHTML =
      '<div class="vd-head"><div class="vd-ttl">Needs you <span class="vd-n"></span></div>' +
      '<button type="button" class="vd-b" data-act="size" title="Full screen">' + ICON.full + '</button>' +
      '<button type="button" class="vd-b" data-act="min" title="Minimize">' + ICON.min + '</button>' +
      '<button type="button" class="vd-b" data-act="close" title="Close">' + ICON.close + '</button></div>' +
      '<div class="vd-body" tabindex="-1"></div>';
    document.body.appendChild(panel);
    tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'vn-doom-tab';
    tab.title = 'Back to Needs you';
    tab.innerHTML = ICON.rail + '<b></b>';
    document.body.appendChild(tab);
    tab.addEventListener('click', () => open());
    panel.addEventListener('click', onClick);
    panel.addEventListener('keydown', e => {
      if (e.target.closest('textarea, input')) return;
      if (e.key === 'Escape') { const s = panel.querySelector('.vd-slide.sheet'); if (s) sheet(s, false); else close(); return; }
      if (/^(ArrowDown|ArrowUp|j|k)$/.test(e.key)) {
        e.preventDefault();
        const b = panel.querySelector('.vd-body'), h = b.clientHeight;
        b.scrollTo({ top: (Math.round(b.scrollTop / h) + (/Down|j/.test(e.key) ? 1 : -1)) * h, behavior: 'smooth' });
      }
    });
    apply();
  }

  function apply() {
    if (!panel) return;
    panel.dataset.size = size;
    panel.classList.toggle('in', state === 'open');
    tab.classList.toggle('in', state === 'min');
    const root = document.documentElement;
    root.classList.toggle('vn-doom-open', state === 'open');
    root.classList.toggle('vn-doom-full', size === 'full');
    const sb = panel.querySelector('[data-act="size"]');
    sb.innerHTML = size === 'full' ? ICON.restore : ICON.full;
    sb.title = size === 'full' ? 'Back to the side panel' : 'Full screen';
  }

  function open() {
    build(); hook();
    void panel.offsetWidth;                // start from off-screen, so it always slides out from the right
    state = 'open'; apply();
    const body = panel.querySelector('.vd-body');
    if (!body.firstChild) body.innerHTML = '<div class="vd-empty">Loading…</div>';
    load(true);
    setTimeout(() => body.focus({ preventScroll: true }), 50);
  }
  function close() { if (!panel) return; state = 'closed'; apply(); }
  function minimize() { if (!panel) return; state = 'min'; apply(); }
  function setSize(s) {
    size = s === 'full' ? 'full' : 'drawer';
    try { localStorage.setItem(LS, size); } catch (_e) { /* private mode */ }
    apply();
  }
  function sheet(sec, on) {
    sec.classList.toggle('sheet', on);
    sec.querySelector('.vr-real').setAttribute('aria-hidden', String(!on));
  }

  function onClick(e) {
    const a = e.target.closest('.vd-head [data-act]');
    if (a) {
      const act = a.getAttribute('data-act');
      if (act === 'close') close();
      else if (act === 'min') minimize();
      else if (act === 'size') setSize(size === 'full' ? 'drawer' : 'full');
      return;
    }
    const th = e.target.closest('[data-open-session]');
    if (th) {
      e.preventDefault();
      // Open it beside the panel: from full screen, step back to the side panel.
      if (size === 'full') setSize('drawer');
      const sid = th.getAttribute('data-open-session');
      if (window.VNFeed && VNFeed.openSession) VNFeed.openSession(sid);
      else if (typeof openInGUI === 'function') openInGUI(sid);
      return;
    }
    const pill = e.target.closest('[data-act-i]');
    if (pill) { const sec = pill.closest('.vd-slide'), b = sec && sec._acts && sec._acts[+pill.dataset.actI]; if (b) b.click(); return; }
    const sh = e.target.closest('[data-sheet]');
    if (sh) { const sec = sh.closest('.vd-slide'); if (sec) sheet(sec, !sec.classList.contains('sheet')); return; }
    const nx = e.target.closest('[data-next]');
    if (nx) { const nxt = nx.closest('.vd-slide').nextElementSibling; if (nxt) nxt.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  async function load(force) {
    if (!panel || loading) return;
    loading = true;
    try {
      const r = await fetch('/api/feed?project=' + encodeURIComponent(project()));
      status = r.status;
      const d = r.ok ? await r.json() : {};
      items = (Array.isArray(d.items) ? d.items : []).filter(i => i.group === 'needs');
    } catch (_e) { status = 0; items = []; }
    finally { loading = false; }
    const n = items.length;
    panel.querySelector('.vd-n').textContent = n ? String(n) : '';
    tab.querySelector('b').textContent = String(n);
    const s = status + '|' + items.map(i => i.session_id + ':' + i.verb + ':' + i.ts).join(',');
    if (force || s !== sig) { sig = s; draw(); }
  }

  // ── Pictures: what the summary itself shows ──────────────────────────────
  // Its screenshots (links and look of kind image), and for a choice each
  // option's picture or live page.  A file on this machine loads through
  // /api/card-image, as the summary card's own pictures do (last-card.js _imgSrc).
  const PIC = /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i;
  function picSrc(u) {
    u = String(u || '').trim();
    if (/^\/(api|static)\//.test(u)) return u;
    if (/^(\/(?!\/)|~\/|file:\/\/\/|[A-Za-z]:[\\/])/.test(u)) return '/api/card-image?path=' + encodeURIComponent(u);
    return /^https?:\/\//.test(u) ? u : '';
  }
  function screenPic(v) {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    if (v && typeof v === 'object') v = v.web || v.phone;
    if (v && typeof v === 'object') v = (dark ? v.dark : v.light) || v.dark || v.light;
    return typeof v === 'string' ? v : '';
  }
  /** The summary's first picture: {src, page} or null. */
  function firstPic(card) {
    const n = (card && card.needs) || {};
    const img = [].concat(card && card.links || [], n.look || []).find(l => l && l.kind === 'image' && PIC.test(l.url || '') && picSrc(l.url));
    if (img) return { src: picSrc(img.url) };
    for (const r of n.replies || []) {
      const sc = r && r.screens && r.screens[0];
      if (!sc) continue;
      const im = screenPic(sc.image);
      if (im && picSrc(im)) return { src: picSrc(im) };
      if (PIC.test(sc.url || '') && picSrc(sc.url)) return { src: picSrc(sc.url) };
      if (/^\/static\/scratch\/[^?#]+\.html/.test(sc.url || '')) return { src: sc.url, page: true };
    }
    return null;
  }
  /** The first picture across the top, or a tile drawn from the status and where the work is. */
  function hero(it) {
    const p = firstPic(it.card);
    if (p) return '<div class="vr-shot">' + (p.page
      ? '<span class="vr-frame"><iframe src="' + esc(p.src) + '" loading="lazy" tabindex="-1" aria-hidden="true"></iframe></span>'
      : '<img src="' + esc(p.src) + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'vr-broken\')">') + '</div>';
    const path = (it.card && Array.isArray(it.card.path) ? it.card.path : []).slice(0, 2).join(' › ');
    return '<div class="vr-shot vr-art"><span class="vr-art-ic">' + iconFor(it) + '</span>' +
      (path ? '<span class="vr-art-path">' + esc(path) + '</span>' : '') + '</div>';
  }

  const plain = t => String(t || '').replace(/[*_`#>]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, (_m, t) => t).replace(/\s+/g, ' ').trim();

  function draw() {
    const body = panel.querySelector('.vd-body');
    const top = body.scrollTop;
    if (!items.length) {
      body.innerHTML = '<div class="vd-empty">' + (status === 404 ? 'Not available until the web server restarts.' :
        status === 0 ? 'Could not load the sessions.' : '<b>Nothing needs you.</b><span>New ones land here as sessions finish.</span>') + '</div>';
      return;
    }
    const n = items.length;
    body.innerHTML = items.map((it, i) => {
      const c = it.card || {};
      return '<section class="vd-slide vs-' + esc(it.verb) + '" data-i="' + i + '">' +
        '<div class="vr-main">' +
          '<div class="vr-hero">' + hero(it) + '</div>' +
          '<div class="vr-eyebrow"><span class="vr-ic">' + iconFor(it) + '</span>' + esc(it.label) + '<span class="vr-name">' + esc(it.name || '') + '</span></div>' +
          '<h2 class="vr-title">' + esc(c.title || it.title || it.name) + '</h2>' +
          (c.headline || it.headline ? '<p class="vr-hl">' + esc(plain(c.headline || it.headline)) + '</p>' : '') +
          (c.answer ? '<p class="vr-short">' + esc(plain(c.answer)) + '</p>' : '') +
          '<div class="vr-acts"></div>' +
        '</div>' +
        '<div class="vr-side">' +
          '<button type="button" class="vr-sb" data-sheet title="Full summary">' + ICON.sheet + '</button>' +
          '<button type="button" class="vr-sb" data-open-session="' + esc(it.session_id) + '" title="Open the session">' + ICON.open + '</button>' +
        '</div>' +
        (i < n - 1 ? '<button type="button" class="vr-next" data-next aria-label="Next">' + ICON.down + '</button>' : '') +
        '<div class="vr-real" aria-hidden="true"><div class="vr-grab" data-sheet></div><div class="vd-card"></div></div>' +
      '</section>';
    }).join('') + '<div class="vr-end">You are all caught up.</div>';
    body.querySelectorAll('.vd-slide').forEach(sec => {
      const it = items[+sec.dataset.i], holder = sec.querySelector('.vd-card');
      if (it.card && window.VNFeed && VNFeed.cardInto) VNFeed.cardInto(holder, it);
      else holder.innerHTML = '<div class="vd-nocard">' + esc(it.headline || it.line || 'No summary yet.') + '</div>';
    });
    requestAnimationFrame(() => body.querySelectorAll('.vd-slide').forEach(pills));
    body.scrollTop = top;
  }

  /** The card's own answer buttons that are showing, as pills: its replies or its
   *  choices first, then the verdicts (Done, Standby...). */
  function pills(sec) {
    const real = sec.querySelector('.vr-real'), box = sec.querySelector('.vr-acts');
    const acts = [...real.querySelectorAll('[data-reply], .lm-decide, .lm-yv button[data-verdict]')].filter(el => el.getClientRects().length > 0).slice(0, 4);
    sec._acts = acts;
    box.innerHTML = acts.map((b, k) => {
      const t = (b.querySelector('.tt') || b).textContent.replace(/\s+/g, ' ').trim();
      const ic = b.querySelector('.ic');
      return '<button type="button" class="vr-pill' + (k === 0 ? ' first' : '') + '" data-act-i="' + k + '">' +
        (ic ? '<span class="vr-pi">' + ic.innerHTML + '</span>' : '') + esc(t) + '</button>';
    }).join('');
  }

  function bump() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (state === 'open') load(false); }, REFRESH_MS);
  }
  function hook() {
    if (hooked || typeof socket === 'undefined' || !socket || typeof socket.on !== 'function') return;
    hooked = true;
    ['session_state', 'session_entry', 'session_hold', 'session_renamed', 'sessions_refresh', 'session_started'].forEach(ev => socket.on(ev, bump));
  }

  function start() {
    build();
    hook();
    if (/[?&]needsyou=1(&|$)/.test(location.search)) setTimeout(open, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.VNDoom = { open, close, minimize, setSize, load, state: () => ({ state, size, items: items.length }) };
})();
