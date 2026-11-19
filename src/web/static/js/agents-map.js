/* The Workflow agent map: where each session is in the codebase.
 *
 * The project's folders are tiles sized by how many files they hold; every
 * session that touched files lately, or runs now, is a dot on the folder it
 * worked in most, with its name beside it (the sidebar's status picture and
 * colour).  Pressing a dot opens the agent: its last steps in plain words
 * (Read x, Changed y, Ran z, Asked a helper), Open the session, and its
 * summary card drawn by the app's own card code.  Drawn flat; the same data
 * can be given depth later.  On a narrow screen the tiles give way to a list
 * of the same agents with their steps.
 *
 * Data: GET /api/agents?project= (src/web/routes/sessions_api.py,
 * src/web/agent_map.py).  It registers with feed.js as the "agents" view of
 * Workflow mode.
 */
(function () {
  'use strict';
  let _data = null, _loadedFor = null, _timer = null, _loading = false, _shown = false, _hooked = false, _open = null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const _el = () => document.getElementById('agents-view');
  function _project() { try { return localStorage.getItem('activeProject') || ''; } catch (_e) { return ''; } }
  const MAX_TILES = 18;

  async function load() {
    const el = _el();
    if (!el || _loading || !_shown) return;
    _loading = true;
    const project = _project();
    try {
      const r = await fetch('/api/agents?project=' + encodeURIComponent(project));
      if (!r.ok) { _data = null; _draw(r.status); return; }
      _data = await r.json(); _loadedFor = project; _draw(200);
    } catch (_e) { _data = null; _draw(0); } finally { _loading = false; }
  }

  /** The folder an agent sits on: the tile it touched most files in, else
   *  the nearest tile above that folder, else the root tile. */
  function _tileFor(agent, tiles) {
    const paths = new Set(tiles.map(t => t.path));
    const folders = Object.entries(agent.folders || {}).sort((a, b) => b[1] - a[1]);
    for (const [f] of folders) {
      let p = f;
      while (p && p !== '.') { if (paths.has(p)) return p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'; }
      if (paths.has('.')) return '.';
    }
    return tiles.length ? tiles[0].path : '.';
  }
  function _span(files, max) {
    const r = Math.sqrt(Math.max(1, files) / Math.max(1, max));
    return Math.max(2, Math.min(6, Math.round(2 + 4 * r)));
  }
  function _icon(a) {
    if (window.VNFeed && VNFeed.iconFor) return VNFeed.iconFor({ group: a.group, session_id: a.session_id });
    return '';
  }
  function _ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return 'now';
    if (s < 3600) return Math.round(s / 60) + ' m ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function _steps(a) {
    return (a.steps || []).map(s => '<div class="vna-step"><span class="vna-verb">' + esc(s.verb) + '</span> <span class="vna-obj">' + esc(s.obj) + '</span><span class="vna-when">' + esc(_ago(s.ts)) + '</span></div>').join('') || '<div class="vna-step vna-none">No steps on record yet.</div>';
  }

  function _draw(status) {
    const el = _el();
    if (!el) return;
    if (status === 404) { el.innerHTML = '<div class="vnf-col"><div class="vnf-empty">The agent map is not available yet: the web server has not been restarted since it was added.</div></div>'; return; }
    if (!_data) { el.innerHTML = '<div class="vnf-col"><div class="vnf-empty">Could not load the agent map.</div></div>'; return; }
    const agents = _data.agents || [];
    const tiles = (_data.tree || []).slice(0, MAX_TILES);
    const maxFiles = tiles.reduce((m, t) => Math.max(m, t.files), 1);
    const byTile = {};
    agents.forEach(a => { const p = _tileFor(a, tiles); (byTile[p] = byTile[p] || []).push(a); });
    const live = agents.filter(a => a.live).length, needs = agents.filter(a => a.group === 'needs').length;
    let h = '<div class="vna-wrap">';
    h += '<div class="vnf-quiet vna-quiet"><b>' + live + ' working</b><span>' + needs + ' need you</span><span class="vna-note">tiles: folders · dots: where each session is</span></div>';
    if (!agents.length) h += '<div class="vnf-empty">No session has touched the code lately.</div>';
    h += '<div class="vna-map">';
    tiles.forEach(t => {
      const here = byTile[t.path] || [];
      h += '<div class="vna-tile' + (here.length ? ' has' : '') + '" style="grid-column: span ' + _span(t.files, maxFiles) + ';" data-tile="' + esc(t.path) + '"><div class="vna-f">' + esc(t.path === '.' ? '(root)' : t.path) + '</div><div class="vna-n">' + t.files + ' files</div><div class="vna-dots">' +
        here.map(a => '<button type="button" class="vna-dot vs-' + esc(a.verb) + (a.live ? ' live' : '') + (_open === a.session_id ? ' on' : '') + '" data-agent="' + esc(a.session_id) + '" title="' + esc(a.headline || '') + '">' + _icon(a) + '<span class="vna-nm">' + esc(a.title || a.name) + '</span></button>').join('') +
        '</div></div>';
    });
    const stray = agents.filter(a => !tiles.some(t => t.path === _tileFor(a, tiles)));
    if (stray.length) h += '<div class="vna-tile has" style="grid-column: span 3;"><div class="vna-f">elsewhere</div><div class="vna-dots">' + stray.map(a => '<button type="button" class="vna-dot vs-' + esc(a.verb) + '" data-agent="' + esc(a.session_id) + '">' + _icon(a) + '<span class="vna-nm">' + esc(a.title || a.name) + '</span></button>').join('') + '</div></div>';
    h += '</div>';
    // The list under the map: every agent with its steps (the whole view on a phone).
    h += '<div class="vna-list">' + agents.map(a => '<div class="vna-row vs-' + esc(a.verb) + (_open === a.session_id ? ' open' : '') + '" data-agent="' + esc(a.session_id) + '" role="button" tabindex="0">' + _icon(a) +
      '<div class="vnf-text"><div class="vnf-ttl">' + esc(a.title || a.name) + '</div><div class="vnf-hl">' + esc((a.files || []).slice(0, 3).join(' · ') || a.headline || '') + '</div></div><span class="vnf-act">' + esc(a.label) + '</span></div>' +
      '<div class="vna-open"' + (_open === a.session_id ? '' : ' hidden') + '><div class="vna-steps">' + _steps(a) + '</div><div class="vna-card"></div><div class="vnf-thread"><a href="#" data-thread="' + esc(a.session_id) + '">Open the session ›</a></div></div>').join('') + '</div>';
    h += '</div>';
    el.innerHTML = h;
    if (_open) _fillCard(_open);
  }
  function _fillCard(sid) {
    const el = _el();
    const a = (_data && _data.agents || []).find(x => x.session_id === sid);
    const row = el.querySelector('.vna-row[data-agent="' + CSS.escape(sid) + '"]');
    const box = row && row.nextElementSibling ? row.nextElementSibling.querySelector('.vna-card') : null;
    if (!a || !box) return;
    if (a.card && window.VNFeed && VNFeed.cardInto) VNFeed.cardInto(box, a);
    else box.innerHTML = '';
  }
  function _openAgent(sid) {
    const el = _el();
    const was = _open === sid;
    el.querySelectorAll('.vna-row.open').forEach(r => { r.classList.remove('open'); const o = r.nextElementSibling; if (o) { o.hidden = true; const c = o.querySelector('.vna-card'); if (c) c.innerHTML = ''; } });
    el.querySelectorAll('.vna-dot.on').forEach(d => d.classList.remove('on'));
    if (was) { _open = null; return; }
    _open = sid;
    const row = el.querySelector('.vna-row[data-agent="' + CSS.escape(sid) + '"]');
    const dot = el.querySelector('.vna-dot[data-agent="' + CSS.escape(sid) + '"]');
    if (dot) dot.classList.add('on');
    if (row) { row.classList.add('open'); if (row.nextElementSibling) row.nextElementSibling.hidden = false; _fillCard(sid); row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }

  document.addEventListener('click', e => {
    const el = _el();
    if (!el || !el.contains(e.target)) return;
    const a = e.target.closest('[data-thread]');
    if (a) { e.preventDefault(); if (window.VNFeed && VNFeed.openSession) VNFeed.openSession(a.getAttribute('data-thread')); return; }
    const hit = e.target.closest('[data-agent]');
    if (hit) _openAgent(hit.getAttribute('data-agent'));
  });

  function _bump() {
    if (!_shown || !(window.VNFeed && VNFeed.mode() === 'agents')) return;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => { _timer = null; load(); }, 2500);
  }
  function _hook() {
    if (_hooked || typeof socket === 'undefined' || !socket || typeof socket.on !== 'function') return;
    _hooked = true;
    ['session_state', 'session_entry', 'session_hold'].forEach(ev => socket.on(ev, _bump));
  }

  window.VNAgents = {
    load,
    show() { _shown = true; _hook(); if (_loadedFor !== _project()) load(); },
    hide() { _shown = false; if (_timer) { clearTimeout(_timer); _timer = null; } const el = _el(); if (el) el.innerHTML = ''; _loadedFor = null; _data = null; _open = null; },
    _data: () => _data,
  };
  if (window.VNFeed && VNFeed.register) VNFeed.register('agents', { el: _el, show: window.VNAgents.show, hide: window.VNAgents.hide });
})();
