/* The Workflow queue: top-level tasks in priority order, their status read
 * off their sessions' summary cards.
 *
 * One ordered list of the project's tasks (Needs you, Working, Not started,
 * Standby, Done), each line showing the task, its most urgent session's
 * sentence and its status word.  Pressing a task opens its parts: its
 * subsessions (child tasks, one level) and its sessions, each a line whose
 * summary card opens under it with the buttons live (feed.js draws it).
 * Start on a task that has no session makes its orchestrator: the one
 * session for the task, briefed with the task and the subsession contract
 * (src/web/workflow_queue.py); it opens subsessions for the parts that will
 * need the person and uses subagents for the rest.  Drag a task's handle to
 * reorder; the order is kept per project.  Sessions no task owns sit under
 * "Unfiled".
 *
 * Data: GET /api/queue?project= (src/web/routes/kanban_api.py).  It
 * registers with feed.js as the "queue" view of Workflow mode.
 */
(function () {
  'use strict';
  let _data = null, _open = null, _loadedFor = null, _timer = null, _loading = false, _shown = false, _hooked = false;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const _el = () => document.getElementById('queue-view');
  function _project() { try { return localStorage.getItem('activeProject') || ''; } catch (_e) { return ''; } }
  const GROUP_WORD = { needs: 'Needs you', working: 'Working', new: 'Not started', standby: 'Standby', done: 'Done' };

  async function load() {
    const el = _el();
    if (!el || _loading || !_shown) return;
    _loading = true;
    const project = _project();
    try {
      const r = await fetch('/api/queue?project=' + encodeURIComponent(project));
      if (!r.ok) { _data = null; _draw(r.status); return; }
      _data = await r.json(); _loadedFor = project; _draw(200);
    } catch (_e) { _data = null; _draw(0); } finally { _loading = false; }
  }

  function _icon(group, sid) {
    if (window.VNFeed && VNFeed.iconFor) return VNFeed.iconFor({ group: group, session_id: sid || '' });
    return '<span class="vnf-ic"></span>';
  }
  function _taskRow(t) {
    const right = t.group === 'new' ? '<button type="button" class="vnq-start" data-start="' + esc(t.id) + '">Start</button>'
      : '<span class="vnf-act">' + esc(t.label) + '</span>';
    const sub = t.children && t.children.length ? t.children_done + ' of ' + t.children.length + ' parts done' : (t.sessions.length ? t.sessions.length + (t.sessions.length === 1 ? ' session' : ' sessions') : '');
    const line = t.latest || sub || (t.group === 'new' ? 'No session yet' : '');
    return '<div class="vnq-task vs-' + esc(t.verb) + (_open === t.id ? ' open' : '') + '" data-task="' + esc(t.id) + '" role="button" tabindex="0">' +
      '<span class="vnq-grip" data-grip title="Drag to reorder">⋮⋮</span>' + _icon(t.group, (t.sessions[0] || {}).session_id) +
      '<div class="vnf-text"><div class="vnf-ttl">' + esc(t.title) + '</div><div class="vnf-hl">' + esc(line) + (sub && t.latest ? ' <span class="vnq-sub">· ' + esc(sub) + '</span>' : '') + '</div></div>' + right + '</div>' +
      '<div class="vnq-parts"' + (_open === t.id ? '' : ' hidden') + '>' + _parts(t) + '</div>';
  }
  function _sessLine(s, kind) {
    const right = (s.verb === 'working' || s.verb === 'waiting') && s.eta_minutes ? s.label + ' · ' + s.eta_minutes + ' min' : s.label;
    return '<div class="vnq-sess vnf-row vs-' + esc(s.verb) + '" data-sid="' + esc(s.session_id) + '" role="button" tabindex="0">' + _icon(s.group, s.session_id) +
      '<div class="vnf-text"><div class="vnf-ttl">' + esc(s.title || s.session_id) + (kind ? ' <span class="vnq-kind">' + esc(kind) + '</span>' : '') + '</div><div class="vnf-hl">' + esc(s.headline || '') + '</div></div>' +
      '<span class="vnf-act">' + esc(right) + '</span></div><div class="vnf-open"></div>';
  }
  function _parts(t) {
    let h = '';
    t.sessions.forEach((s, i) => { h += _sessLine(s, i === 0 ? 'orchestrator' : ''); });
    (t.children || []).forEach(k => {
      h += '<div class="vnq-child vs-' + esc(k.verb) + '">' + _icon(k.group, (k.sessions[0] || {}).session_id) + '<div class="vnf-text"><div class="vnf-ttl">' + esc(k.title) + ' <span class="vnq-kind">subsession</span></div>' +
        (k.latest ? '<div class="vnf-hl">' + esc(k.latest) + '</div>' : '') + '</div><span class="vnf-act">' + esc(k.label) + '</span></div>';
      k.sessions.forEach(s => { h += _sessLine(s, ''); });
    });
    if (!t.sessions.length && !(t.children || []).length) h += '<div class="vnq-empty">No session yet. Start makes this task\'s orchestrator.</div>';
    return h;
  }

  function _draw(status) {
    const el = _el();
    if (!el) return;
    let h = '<div class="vnf-col vnq-col">';
    if (status === 404) h += '<div class="vnf-empty">The queue is not available yet: the web server has not been restarted since it was added.</div></div>';
    else if (!_data) h += '<div class="vnf-empty">Could not load the queue.</div></div>';
    else {
      const tasks = _data.tasks || [];
      const counts = {};
      tasks.forEach(t => { counts[t.group] = (counts[t.group] || 0) + 1; });
      if (!tasks.length) h += '<div class="vnf-empty">No tasks yet. New task, in the Workflow sidebar, adds one.</div>';
      else h += '<div class="vnf-quiet">' + ['needs', 'working', 'new'].filter(g => counts[g]).map((g, i) => (i ? '<span>' : '<b>') + counts[g] + ' ' + GROUP_WORD[g].toLowerCase() + (i ? '</span>' : '</b>')).join('') + '</div>';
      let lastGroup = null;
      tasks.forEach(t => {
        if (t.group !== lastGroup) { lastGroup = t.group; h += '<div class="vnq-group vs-' + (t.group === 'new' ? 'new' : t.group) + '">' + GROUP_WORD[t.group] + '</div>'; }
        h += _taskRow(t);
      });
      const un = _data.unfiled || [];
      if (un.length) {
        h += '<div class="vnq-group vs-needs">Unfiled sessions <span class="vnq-n">· ' + un.length + '</span></div>';
        un.forEach(s => { h += _sessLine(s, ''); });
      }
      h += '</div>';
    }
    el.innerHTML = h;
  }

  function _openTask(row) {
    const id = row.getAttribute('data-task');
    const parts = row.nextElementSibling;
    const was = row.classList.contains('open');
    _el().querySelectorAll('.vnq-task.open').forEach(r => { r.classList.remove('open'); const p = r.nextElementSibling; if (p) p.hidden = true; });
    if (was) { _open = null; return; }
    row.classList.add('open'); _open = id;
    if (parts) parts.hidden = false;
  }
  function _openSess(row) {
    const holder = row.nextElementSibling && row.nextElementSibling.classList.contains('vnf-open') ? row.nextElementSibling : null;
    const was = row.classList.contains('open');
    _el().querySelectorAll('.vnq-sess.open').forEach(r => { r.classList.remove('open'); const hh = r.nextElementSibling; if (hh && hh.classList.contains('vnf-open')) hh.innerHTML = ''; });
    if (was || !holder) return;
    row.classList.add('open');
    const sid = row.getAttribute('data-sid');
    const it = _find(sid);
    if (!it) return;
    if (!it.card) { holder.innerHTML = '<div class="vnf-nocard">' + (it.group === 'working' ? 'Working; its summary comes when it stops.' : 'No summary yet.') + ' <a href="#" data-thread="' + esc(sid) + '">Open the session ›</a></div>'; return; }
    if (window.VNFeed && VNFeed.cardInto) VNFeed.cardInto(holder, it);
    holder.insertAdjacentHTML('beforeend', '<div class="vnf-thread"><a href="#" data-thread="' + esc(sid) + '">Open the session ›</a></div>');
  }
  function _find(sid) {
    if (!_data) return null;
    for (const t of _data.tasks || []) {
      for (const s of t.sessions) if (s.session_id === sid) return s;
      for (const k of t.children || []) for (const s of k.sessions) if (s.session_id === sid) return s;
    }
    return (_data.unfiled || []).find(s => s.session_id === sid) || null;
  }

  /** Start a task's orchestrator: a new session briefed with the task and
   *  the subsession contract, launched the way the board launches a task
   *  (kanban.js executeTask), then linked to the task. */
  async function start(taskId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
    const newId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
    try {
      const r = await fetch('/api/queue/tasks/' + encodeURIComponent(taskId) + '/prompt?session_id=' + encodeURIComponent(newId) + '&project=' + encodeURIComponent(_project()));
      if (!r.ok) throw new Error('prompt ' + r.status);
      const d = await r.json();
      let systemPrompt = d.system_prompt || '';
      if (typeof FOLDER_SUPERSET === 'object' && FOLDER_SUPERSET) {
        if (typeof _ensureAgentCatalog === 'function') await _ensureAgentCatalog();
        if (typeof _buildAgentDefinitions === 'function') { const a = _buildAgentDefinitions(); if (a) systemPrompt += '\n\n' + a; }
      }
      if (typeof _buildCopyExportNote === 'function') systemPrompt += '\n\n' + _buildCopyExportNote();
      const opts = { session_id: newId, prompt: d.prompt || '', cwd: typeof _currentProjectDir === 'function' ? _currentProjectDir() : '', name: d.name || '' };
      if (typeof SessionModel !== 'undefined') {
        const m = SessionModel.effectivePending(newId); if (m) opts.model = m;
        const th = SessionModel.getDesiredThinking(newId); if (th) opts.thinking_level = th;
      }
      if (systemPrompt) opts.system_prompt = systemPrompt;
      if (typeof runningIds !== 'undefined') runningIds.add(newId);
      if (typeof sessionKinds !== 'undefined') sessionKinds[newId] = 'working';
      socket.emit('start_session', opts);
      await fetch('/api/kanban/tasks/' + encodeURIComponent(taskId) + '/sessions?project=' + encodeURIComponent(_project()),
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: newId, session_type: 'session' }) });
      if (typeof showToast === 'function') showToast('Orchestrator started: ' + (d.name || 'the task'));
      _open = taskId;
      setTimeout(load, 800);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Start'; }
      if (typeof showToast === 'function') showToast('Could not start the task: ' + (e && e.message || e), true);
    }
  }

  // ── Drag a task to reorder (mouse): the row lifts and the others slide. ──
  let _drag = null;
  function _onDown(e) {
    const grip = e.target.closest('[data-grip]');
    if (!grip || e.button !== 0) return;
    const row = grip.closest('.vnq-task');
    if (!row) return;
    e.preventDefault();
    _drag = { row: row, y: e.clientY, moved: false };
    document.addEventListener('mousemove', _onMove);
    document.addEventListener('mouseup', _onUp, { once: true });
  }
  function _onMove(e) {
    if (!_drag) return;
    const d = _drag;
    if (!d.moved && Math.abs(e.clientY - d.y) < 5) return;
    d.moved = true; d.row.classList.add('vnq-lifted');
    const rows = [..._el().querySelectorAll('.vnq-task')].filter(r => r !== d.row);
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (e.clientY < b.top + b.height / 2 && r.compareDocumentPosition(d.row) & Node.DOCUMENT_POSITION_FOLLOWING) {
        r.parentNode.insertBefore(d.row, r); r.parentNode.insertBefore(d.row.nextElementSibling && d.row.nextElementSibling.classList.contains('vnq-parts') ? d.row.nextElementSibling : document.createTextNode(''), r);
        return;
      }
      if (e.clientY > b.top + b.height / 2 && r.compareDocumentPosition(d.row) & Node.DOCUMENT_POSITION_PRECEDING) {
        const after = r.nextElementSibling && r.nextElementSibling.classList.contains('vnq-parts') ? r.nextElementSibling : r;
        const parts = d.row.nextElementSibling && d.row.nextElementSibling.classList.contains('vnq-parts') ? d.row.nextElementSibling : null;
        after.parentNode.insertBefore(d.row, after.nextSibling);
        if (parts) d.row.parentNode.insertBefore(parts, d.row.nextSibling);
        return;
      }
    }
  }
  async function _onUp() {
    document.removeEventListener('mousemove', _onMove);
    const d = _drag; _drag = null;
    if (!d) return;
    d.row.classList.remove('vnq-lifted');
    if (!d.moved) return;
    const ids = [..._el().querySelectorAll('.vnq-task')].map(r => r.getAttribute('data-task'));
    try {
      await fetch('/api/queue/order?project=' + encodeURIComponent(_project()), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    } catch (_e) { /* the next load shows the saved order */ }
    // Groups stay fixed: a row dragged into another group goes back to its own.
    load();
  }

  document.addEventListener('click', e => {
    const el = _el();
    if (!el || !el.contains(e.target)) return;
    const st = e.target.closest('[data-start]');
    if (st) { e.preventDefault(); start(st.getAttribute('data-start'), st); return; }
    const a = e.target.closest('[data-thread]');
    if (a) { e.preventDefault(); if (window.VNFeed && VNFeed.openSession) VNFeed.openSession(a.getAttribute('data-thread')); return; }
    if (e.target.closest('[data-grip]')) return;
    const sess = e.target.closest('.vnq-sess');
    if (sess) { _openSess(sess); return; }
    const task = e.target.closest('.vnq-task');
    if (task) _openTask(task);
  });
  document.addEventListener('mousedown', e => { const el = _el(); if (el && el.contains(e.target)) _onDown(e); });

  function _bump() {
    if (!_shown || !(window.VNFeed && VNFeed.mode() === 'queue')) return;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => { _timer = null; load(); }, 1500);
  }
  function _hook() {
    if (_hooked || typeof socket === 'undefined' || !socket || typeof socket.on !== 'function') return;
    _hooked = true;
    ['session_state', 'session_entry', 'session_hold', 'kanban_task_created', 'kanban_task_updated', 'kanban_task_moved', 'kanban_board_refresh'].forEach(ev => socket.on(ev, _bump));
  }

  window.VNQueue = {
    load, start,
    show() { _shown = true; _hook(); if (_loadedFor !== _project()) load(); },
    hide() { _shown = false; if (_timer) { clearTimeout(_timer); _timer = null; } const el = _el(); if (el) el.innerHTML = ''; _loadedFor = null; _data = null; _open = null; },
    _data: () => _data,
  };
  if (window.VNFeed && VNFeed.register) VNFeed.register('queue', { el: _el, show: window.VNQueue.show, hide: window.VNQueue.hide });
})();
