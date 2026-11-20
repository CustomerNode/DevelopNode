/* toolbar.js — toolbar session management, inline rename, message rendering, session actions */
let _hpBoardFetching = false;
let _hpBoardLoaded = false;
let _hpComposeFetching = false;
let _hpComposeLoaded = false;
let _hpComposeTasks = [];
let _hpComposeColumns = [];

function setToolbarSession(id, titleText, isUntitled, customTitle) {
  const titleEl = document.getElementById('main-title');
  titleEl.textContent = titleText;
  titleEl.className = 'session-name' + (isUntitled ? ' untitled' : '');
  titleEl.dataset.customTitle = customTitle || '';
  titleEl.dataset.editable = id ? 'true' : 'false';
  titleEl.title = id ? 'Click to rename' : '';
  // Enable/disable action buttons regardless of view mode — the Actions
  // popup uses these same buttons even in kanban mode.
  ['btn-autoname','btn-open','btn-open-gui','btn-delete','btn-duplicate','btn-continue','btn-summary','btn-extract','btn-export','btn-fork','btn-rewind','btn-fork-rewind','btn-spawn-subsession'].forEach(b => {
    const el = document.getElementById(b);
    if (el) el.disabled = !id;
  });
  // In kanban mode, main-toolbar NEVER shows (actions are in the crumb bar)
  if (typeof viewMode !== 'undefined' && viewMode === 'kanban') {
    document.getElementById('main-toolbar').style.display = 'none';
    return;
  }
  document.getElementById('main-toolbar').style.display = id ? '' : 'none';
  // btn-close enabled when session is running or open in GUI
  const btnClose = document.getElementById('btn-close');
  if (btnClose) btnClose.disabled = !id || (!runningIds.has(id) && !guiOpenSessions.has(id));
  // Reset cost badge and status bar on session switch
  const costEl = document.getElementById('session-cost');
  if (costEl) costEl.textContent = '$0.00';
  const sbCost = document.getElementById('sb-cost');
  if (sbCost) sbCost.textContent = '$0.00';
  const sbModel = document.getElementById('sb-model');
  if (sbModel) sbModel.textContent = '\u2014';
}

function deselectSession() {
  if (viewMode === 'homepage') return;
  activeId = null;
  localStorage.removeItem('activeSessionId');
  _pushChatUrl(null);
  // IMPORTANT: save draft, do NOT auto-send (see live-panel.js warning block)
  if (liveSessionId) { _savePendingInputAsDraft(); stopLivePanel(); }
  // In workspace mode, return to workspace canvas instead of dashboard
  if (workspaceActive) {
    _wsExpandedId = null;
    const btn = document.getElementById('ws-back-btn');
    if (btn) btn.remove();
    document.getElementById('main-toolbar').style.display = 'none';
    filterSessions();
    return;
  }
  // In kanban mode, restore the board
  if (typeof viewMode !== 'undefined' && viewMode === 'kanban') {
    const kb = document.getElementById('kanban-board');
    const mb = document.getElementById('main-body');
    if (kb) kb.style.display = '';
    if (mb) mb.style.display = 'none';
    document.getElementById('main-toolbar').style.display = 'none';
    const sessionBar = document.getElementById('kanban-session-bar');
    if (sessionBar) sessionBar.remove();
    window._kanbanSessionTaskId = null;
    if (typeof initKanban === 'function') initKanban(true);
    filterSessions();
    return;
  }
  filterSessions();
  setToolbarSession(null, 'No session selected', true, '');
  document.getElementById('main-body').innerHTML = _buildDashboard();
}

/** Cancel on a new session that has sent nothing: close it AND drop it, so
 *  no "New Session" row, draft or folder entry is left behind (the X only
 *  closes the view and keeps the row). */
function cancelNewSession() {
  const id = activeId;
  // Only ever drawn on a session with nothing sent; a running one is kept.
  if (!id || runningIds.has(id)) { deselectSession(); return; }
  const ta = document.getElementById('live-input-ta');
  if (ta) ta.value = '';                       // deselect must not save it as a draft
  window._pendingTemplateSystemPrompt = null;
  deselectSession();
  if (typeof _clearDraft === 'function') _clearDraft(id);
  if (typeof removeSessionFromFolder === 'function') { try { removeSessionFromFolder(id); } catch (_e) { /* not in a folder */ } }
  guiOpenDelete(id);
  SessionStore.remove(id);
  filterSessions();
}

/** The Cancel button drawn under a new session's suggested prompts. */
function _newSessionCancelHtml() {
  return '<div><button class="new-session-cancel" onclick="cancelNewSession()" title="Discard this new session">Cancel</button></div>';
}

function handleSessionClick(id) {
  if (id === activeId) { startListInlineRename(); } else { selectSession(id); }
}

/**
 * _ensureMainBodyVisible() — If in kanban mode, swap the board out and show
 * main-body + back button. Called before ANY action that renders into main-body.
 * Safe to call from any view — no-ops if not in kanban.
 */
function _ensureMainBodyVisible() {
  if (typeof viewMode === 'undefined' || viewMode !== 'kanban') return;
  // Don't touch kanban-board or main-body — the session renders inside kanban-board
  // with the kanban titlebar. openSessionSpawner in kanban.js handles this.
}

function _backToKanban() { deselectSession(); }
function _showKanbanBackBtn() {}

async function handleNameClick(id) {
  // If the prior mousedown was a Ctrl/Cmd+click on the row that already
  // toggled the multi-select state, swallow this name-cell click so we
  // don't ALSO open or rename the session.
  if (typeof _consumeMsSuppression === 'function' && _consumeMsSuppression()) {
    return;
  }
  // Plain click on a session-name cell clears any active multi-selection.
  // Matches Finder/Explorer/VS Code: clicking on a non-selected target
  // collapses the working set.  Programmatic callers (e.g. _sessCtx('rename'))
  // also harmlessly clear the selection — that's the right behavior since
  // a rename is a single-target action.
  if (typeof multiSelectedIds !== 'undefined' && multiSelectedIds.size > 0
      && typeof _clearMultiSelect === 'function') {
    _clearMultiSelect();
  }
  if (id !== activeId) {
    openInGUI(id);
  } else {
    startListInlineRename();
  }
}

async function selectSession(id) {
  if (window.VNAllProjects) VNAllProjects.adopt(id);   // All projects: act in its own project
  // Viewing a session counts as reading it — drop the unread dot.
  if (typeof clearSessionUnread === 'function') clearSessionUnread(id);

  // Opening a session must NOT change its sidebar position — the sort is
  // driven by state and real activity only, never by the act of clicking.
  // (Previously a "touch" call bumped effective_ts to now here, yanking the
  // clicked session to the top.  That behavior was removed.)

  // In workspace mode, delegate to expandWorkspaceCard to prevent poll clobbering
  if (workspaceActive && typeof expandWorkspaceCard === 'function') {
    expandWorkspaceCard(id);
    return;
  }

  _ensureMainBodyVisible();

  activeId = id;
  localStorage.setItem('activeSessionId', id || '');
  _pushChatUrl(id);
  // IMPORTANT: save draft, do NOT auto-send (see live-panel.js warning block)
  if (liveSessionId && liveSessionId !== id) {
    _savePendingInputAsDraft();
    stopLivePanel();
  }
  filterSessions();

  setToolbarSession(id, 'Loading\u2026', true, '');
  document.getElementById('main-body').innerHTML = _chatSkeleton();

  const _proj = localStorage.getItem('activeProject') || '';
  const _projQ = _proj ? '?project=' + encodeURIComponent(_proj) : '';
  const resp = await fetch('/api/session/' + id + _projQ);
  const s = await resp.json();

  const titleText = s.custom_title || s.display_title;
  setToolbarSession(id, titleText, !s.custom_title, s.custom_title || '');

  // Single click always shows static preview; double click / openInGUI starts live panel
  // For very long sessions, show only the last 200 messages with a "Load more" button
  const MAX_INITIAL = 200;
  const msgs = s.messages || [];
  const truncated = msgs.length > MAX_INITIAL;
  const visibleMsgs = truncated ? msgs.slice(-MAX_INITIAL) : msgs;
  let loadMoreHtml = '';
  if (truncated) {
    loadMoreHtml = '<div style="text-align:center;padding:12px;"><button class="btn" id="btn-load-all" onclick="loadAllMessages(\'' + id + '\')">'
      + 'Load all ' + msgs.length + ' messages</button></div>';
  }
  document.getElementById('main-body').innerHTML =
    '<div class="conversation" id="convo">' + loadMoreHtml + renderMessages(visibleMsgs) + '</div>';
  _addCopyButtonsToConvo();
  setTimeout(() => {
    const convo = document.getElementById('convo');
    if (convo) {
      convo.scrollTop = convo.scrollHeight;
      if (typeof initStickyUserMessages === 'function') initStickyUserMessages(convo);
    }
  }, 50);
}

function startListInlineRename() {
  if (!activeId) return;

  // Find the active row's name cell in the list
  const activeRow = document.querySelector('.session-item.active');
  if (!activeRow) return;
  const nameCell = activeRow.querySelector('.session-col-name');
  if (!nameCell) return;

  const s = allSessions.find(x => x.id === activeId);
  const current = (s && (s.custom_title || s.display_title)) || '';
  const originalHTML = nameCell.innerHTML;

  // Replace cell content with an input
  const input = document.createElement('input');
  input.style.cssText = 'width:100%;background:var(--bg-input);border:1px solid var(--border-focus);border-radius:4px;padding:2px 6px;color:var(--text-primary);font-size:12px;outline:none;';
  input.value = current;
  input.placeholder = 'Enter a name\u2026';
  nameCell.innerHTML = '';
  nameCell.appendChild(input);

  // Prevent row click from firing while editing
  activeRow.onclick = null;
  input.focus();
  input.select();  // all text selected — edit in place or Delete to clear

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    // Restore click handler
    activeRow.onclick = () => handleSessionClick(activeId);

    if (!val || val === current) {
      nameCell.innerHTML = originalHTML;
      return;
    }

    _userNamedSessions.add(activeId);  // kill auto-naming instantly
    const resp = await fetch('/api/rename/' + activeId, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({title: val, project: localStorage.getItem('activeProject') || ''})
    });
    const data = await resp.json();
    if (data.ok) {
      _userNamedSessions.add(activeId);  // protect from auto-naming
      if (typeof _rememberSessionTitle === 'function') _rememberSessionTitle(activeId, data.title);
      if (s) { s.custom_title = data.title; s.display_title = data.title; }
      setToolbarSession(activeId, data.title, false, data.title);
      nameCell.textContent = data.title;
      showToast('Renamed to "' + data.title + '"');
    } else {
      nameCell.innerHTML = originalHTML;
      showToast(data.error || 'Rename failed', true);
    }
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; activeRow.onclick = () => handleSessionClick(activeId); nameCell.innerHTML = originalHTML; }
  });
  input.addEventListener('blur', commit);
}

function submitListInlineRename() {
  // Alias for compatibility — commit is handled by blur/enter in startListInlineRename
}

function cancelListInlineRename() {
  // Alias for compatibility — escape is handled in startListInlineRename
}

// The three statuses the sidebar draws:
// Needs you, Working, Done.  Counted from session-verb.js so the homepage and
// the empty Sessions view say exactly what the cards say.
function _hpThree(polled) {
  if (!polled) return { needs: '-', working: '-', standby: '-', done: '-' };
  const c = { needs: 0, working: 0, standby: 0, done: 0 };
  allSessions.forEach(s => {
    let g;
    if (window.SessionVerb && window.SessionVerb.shown) g = window.SessionVerb.shown(window.SessionVerb.display(s.id));
    else {
      const k = runningIds.has(s.id) ? sessionKinds[s.id] : 'sleeping';
      g = k === 'working' ? 'working' : (k === 'question' || k === 'idle') ? 'needs' : 'done';
    }
    c[g] = (c[g] || 0) + 1;
  });
  return c;
}

function _buildDashboard() {
  const project = _allProjects.find(p => p.encoded === localStorage.getItem('activeProject'));
  const projectName = (window.VNAllProjects && VNAllProjects.on()) ? (VNAllProjects.label ? VNAllProjects.label() : 'All projects') : (project ? _projectShortName(project) : 'No project');
  const total = allSessions.length;
  const polled = _waitingPolledOnce || false;
  const working = polled ? allSessions.filter(s => runningIds.has(s.id) && sessionKinds[s.id] === 'working').length : '-';
  const idle = polled ? allSessions.filter(s => runningIds.has(s.id) && sessionKinds[s.id] === 'idle').length : '-';
  const question = polled ? allSessions.filter(s => runningIds.has(s.id) && sessionKinds[s.id] === 'question').length : '-';
  const sleeping = polled ? total - (typeof working === 'number' ? working + idle + question : 0) : '-';

  // The empty Sessions view: the project as a heading, four plain status
  // counts, the sessions waiting on the user (if any), and one primary action.
  // No boxes; same pieces and type as the homepage's Sessions card (".dx-*").
  const _n = (n, label, cls) => `<div class="dx-num ${n && n !== '-' ? cls : 'zero'}"><b>${n}</b><span>${label}</span></div>`;
  const _c3 = _hpThree(polled);
  // Smart termination off: the process counts it showed before (session-verb.js gate).
  const nums = window.SessionVerb
    ? _n(_c3.needs, 'Needs you', 'wait') + _n(_c3.working, 'Working', 'work')
      + (_c3.standby && _c3.standby !== '-' ? _n(_c3.standby, 'Standby', '') : '') + _n(_c3.done, 'Done', '')
    : _n(working, 'Working', 'work') + _n(question, 'Waiting on you', 'wait') + _n(idle, 'Idle', '') + _n(sleeping, 'Sleeping', '');
  const _key = s => s.effective_ts || s.last_activity_ts || s.sort_ts || 0;
  const waiting = polled ? allSessions.filter(s => runningIds.has(s.id) && sessionKinds[s.id] === 'question')
    .sort((a, b) => _key(b) - _key(a)).slice(0, 4) : [];
  const waitingHtml = waiting.map(s => {
    const sid = String(s.id).replace(/[^A-Za-z0-9_-]/g, '');
    return `<div class="dx-row" onclick="openInGUI('${sid}')" title="${escHtml(s.display_title || '')}">`
      + `<span class="dx-dot"></span><span class="t">${escHtml(s.display_title || s.id)}</span>`
      + `<span class="d">${escHtml(typeof _shortDate === 'function' ? _shortDate(s.last_activity) : '')}</span></div>`;
  }).join('');

  return `
  <div class="dashboard dx">
    <div class="dx-head">
      <div class="dx-label">Project</div>
      <button class="dx-project" onclick="openProjectOverlay()" title="Switch project">
        <span class="dx-project-name">${escHtml(projectName)}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
    </div>

    <div class="dx-nums">${nums}</div>

    ${typeof _usageStatusTriggerHtml === 'function' ? `<div class="dx-usage">${_usageStatusTriggerHtml()}</div>` : ''}

    ${waitingHtml ? `<div class="dx-sec"><div class="dx-label">Waiting on you</div><div class="dx-list">${waitingHtml}</div></div>` : ''}

    <div class="dx-actions">
      <button class="dx-new" onclick="addNewAgent()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New session
      </button>
      <span class="dx-hint">${total > 0 ? 'or pick one from the list' : (project ? 'to get started' : 'Select a project to get started')}</span>
    </div>
  </div>`;
}

/* The Home screen: a project chooser (the "dashboard" finish).  Projects run
 * down the left as cards (a coloured initial, name, sessions, last activity,
 * how many need you); the right previews the chosen one: Open, three numbers
 * (Needs you, Working, sessions active this week with a 7-day line) and the
 * sessions behind the first two.  The current project is chosen at first.
 *
 * The current project's numbers and lists are live (SessionStore and the
 * state maps, as the sidebar draws them); other projects come from
 * GET /api/project-status?detail=1, read again at most every 10 s. */
let _hpSel = null;              // encoded project shown in the preview
let _hpDetail = {};             // encoded -> project-status detail
let _hpDetailAt = 0;
let _hpDetailBusy = false;
let _hpAnimate = true;          // play the rise-in on the next draw (a new choice)

/** A project's initial in a small outlined tile, as the All projects view
 *  draws it: no project colours, because colour on these screens means status. */
function _hpMono(name, size) {
  const ch = (String(name || '').trim().charAt(0) || '?').toUpperCase();
  return `<span class="hd-mono" style="width:${size}px;height:${size}px">${escHtml(ch)}</span>`;
}
function _hpAgo(ts) {
  if (!ts) return '';
  const m = Math.max(0, (Date.now() / 1000 - ts) / 60);
  if (m < 2) return 'just now';
  if (m < 60) return Math.round(m) + ' min ago';
  if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
  const d = Math.round(m / 1440);
  return d === 1 ? 'yesterday' : d + ' days ago';
}
function _hpProjects() {
  return (typeof _allProjects !== 'undefined' && Array.isArray(_allProjects)) ? _allProjects : [];
}
function _hpActiveEnc() { return localStorage.getItem('activeProject') || ''; }

/** Read every project's detail (one call), at most every 10 s. */
function _hpLoadDetail(force) {
  const list = _hpProjects();
  if (!list.length || _hpDetailBusy || (!force && Date.now() - _hpDetailAt < 10000)) return;
  _hpDetailBusy = true;
  fetch('/api/project-status?detail=1&projects=' + encodeURIComponent(list.map(p => p.encoded).join(',')), { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(async data => {
      _hpDetailAt = Date.now();
      if (data) Object.assign(_hpDetail, data);
      // A web server older than ?detail=1 answers counts only: fill the chosen
      // project's lists from its session list instead.
      const sel = _hpSel || _hpActiveEnc();
      if (sel !== _hpActiveEnc() && _hpDetail[sel] && !_hpDetail[sel].items) await _hpDetailFromSessions(sel);
    })
    .catch(() => {})
    .finally(() => { _hpDetailBusy = false; _hpAnimate = false; _updateHomepageStats(); });
}
async function _hpDetailFromSessions(enc) {
  try {
    const r = await fetch('/api/sessions?project=' + encodeURIComponent(enc), { cache: 'no-store' });
    const rows = r.ok ? await r.json() : [];
    const items = { needs: [], working: [], standby: [] };
    const daily = _hpDaily(rows);
    let last = 0;
    for (const x of rows) {
      last = Math.max(last, x.last_activity_ts || x.sort_ts || 0);
      if (x.hold === 'done') continue;
      if (x.hold === 'standby') { items.standby.push(x); continue; }
      const verb = x.next_step && x.next_step.verb;
      const g = verb === 'waiting' ? 'working' : (verb || x.message_count) ? 'needs' : null;
      if (g) items[g].push(x);
    }
    const pick = arr => arr.sort((p, q) => (q.last_activity_ts || 0) - (p.last_activity_ts || 0)).slice(0, 5)
      .map(x => ({ id: x.id, title: x.display_title || '', ts: x.last_activity_ts || 0 }));
    const had = _hpDetail[enc] || {};
    // Counts from the list until the live ones arrive (GET /api/project-status).
    const counts = ('needs' in had) ? {} : { needs: items.needs.length, working: items.working.length, standby: items.standby.length };
    _hpDetail[enc] = Object.assign({}, had, counts, {
      items: { needs: pick(items.needs), working: pick(items.working), standby: pick(items.standby) },
      last_ts: last, daily });
  } catch (e) { /* the preview shows the counts only */ }
}

/** Sessions last active on each of the last 7 days, oldest first, ending today. */
function _hpDaily(rows) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = start.getTime() / 1000;
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const x of rows) {
    const ts = x.last_activity_ts || x.sort_ts || 0;
    if (!ts) continue;
    const back = ts >= today ? 0 : Math.ceil((today - ts) / 86400);
    if (back <= 6) out[6 - back]++;
  }
  return out;
}

/** The preview's numbers and lists for one project. */
function _hpProjectView(enc) {
  const d = _hpDetail[enc] || null;
  if (enc === _hpActiveEnc()) {
    // The open project: live, from the same state the sidebar draws.
    const polled = _waitingPolledOnce || false;
    const lists = _hpAttentionLists(polled);
    const c3 = _hpThree(polled);
    return {
      live: true, polled,
      needs: c3.needs === '-' ? 0 : c3.needs, working: c3.working === '-' ? 0 : c3.working,
      needItems: lists.needs.map(x => ({ id: x.s.id, title: x.s.display_title || x.s.id, why: x.why })),
      runItems: lists.running.map(s => ({ id: s.id, title: s.display_title || s.id, since: _hpSince(s) })),
      last: allSessions.reduce((m, s) => Math.max(m, s.last_activity_ts || 0), 0) || (d && d.last_ts) || 0,
      daily: _hpDaily(allSessions),
    };
  }
  const it = (d && d.items) || {};
  return {
    live: false, polled: !!d,
    needs: d ? d.needs : '–', working: d ? d.working : '–',
    needItems: (it.needs || []).map(x => ({ id: x.id, title: x.title || x.id })),
    runItems: (it.working || []).map(x => ({ id: x.id, title: x.title || x.id, since: _hpAgo(x.ts) })),
    last: d ? d.last_ts : 0, daily: d && d.daily,
  };
}

function _hpSpark(v) {
  if (!Array.isArray(v) || v.length < 2) return '';
  const w = 120, h = 26, m = Math.max(1, ...v);
  const pts = v.map((y, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 2 - (y / m) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="hd-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Every project's Needs you / Standby / Working counts, from the same
 *  sources as the project picker (app.js): the last fetched counts, this
 *  page's own detail fetch, and the open project's live statuses. */
function _hpCounts() {
  const out = Object.assign({}, window._projectStatusCounts || {});
  for (const [enc, d] of Object.entries(_hpDetail)) {
    if (d && 'needs' in d) out[enc] = { needs: d.needs || 0, standby: d.standby || 0, working: d.working || 0 };
  }
  return Object.assign(out, (typeof _localProjectCounts === 'function') ? _localProjectCounts() : {});
}
/** The picker's three count cells for one project (app.js _renderProjectOverlay). */
function _hpCountCells(c) {
  const groups = (typeof _PS_GROUPS !== 'undefined') ? _PS_GROUPS : ['needs', 'standby', 'working'];
  const label = (typeof _PS_LABEL !== 'undefined') ? _PS_LABEL : { needs: 'Needs you', standby: 'Standby', working: 'Working' };
  return '<span class="ps-cols">' + groups.map(g => {
    const n = c ? (c[g] || 0) : null;
    return n ? `<span class="ps-n vs-${g}" title="${n} ${label[g].toLowerCase()}">${n}</span>`
             : `<span class="ps-n zero">${n === null ? '' : '\u00b7'}</span>`;
  }).join('') + '</span>';
}

function _hpSideHtml() {
  const act = _hpActiveEnc();
  const sel = _hpSel || act;
  const counts = _hpCounts();
  const groups = (typeof _PS_GROUPS !== 'undefined') ? _PS_GROUPS : ['needs', 'standby', 'working'];
  const label = (typeof _PS_LABEL !== 'undefined') ? _PS_LABEL : { needs: 'Needs you', standby: 'Standby', working: 'Working' };
  const head = '<div class="ps-head hd-ps-head" aria-hidden="true"><span></span>'
    + groups.map(g => `<span title="${label[g]}">${typeof _psIcon === 'function' ? _psIcon(g) : ''}</span>`).join('') + '</div>';
  const list = _hpProjects().slice().sort((x, y) => (y.encoded === act) - (x.encoded === act));
  const rows = list.map(p => {
    const name = _projectShortName(p);
    const d = _hpDetail[p.encoded];
    const last = p.encoded === act ? _hpProjectView(act).last : (d && d.last_ts);
    return `<button type="button" class="hd-proj${p.encoded === sel ? ' on' : ''}" data-enc="${escHtml(p.encoded)}" onclick="_hpChoose(this.dataset.enc)" ondblclick="_hpOpenProject(this.dataset.enc)">`
      + _hpMono(name, 28)
      + `<span class="hd-pt"><span class="nm">${escHtml(name)}</span><span class="s">${p.session_count || 0} session${p.session_count === 1 ? '' : 's'}${last ? ' · ' + _hpAgo(last) : ''}</span></span>`
      + _hpCountCells(counts[p.encoded])
      + `</button>`;
  }).join('');
  return head + rows + `<button type="button" class="hd-proj hd-add" onclick="_hpAddProject()"><span class="hd-mono hd-mono-add">+</span><span class="hd-pt"><span class="nm">Add a project</span></span></button>`;
}

function _hpPaneHtml() {
  const act = _hpActiveEnc();
  const sel = _hpSel || act;
  const p = _hpProjects().find(x => x.encoded === sel);
  const name = (sel === act && window.VNAllProjects && VNAllProjects.on()) ? (VNAllProjects.label ? VNAllProjects.label() : 'All projects') : (p ? _projectShortName(p) : 'No project');
  const v = _hpProjectView(sel);
  const enc = escHtml(sel);
  const row = (x, kind) => {
    const sid = String(x.id).replace(/[^A-Za-z0-9_-]/g, '');
    const lead = kind === 'run' ? '<span class="hs-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
      : `<span class="hpx-ico ${x.why === 'question' ? 'question' : 'unread'}"></span>`;
    const tail = kind === 'run' && x.since ? `<span class="d">${escHtml(x.since)}</span>` : '';
    const click = v.live ? `_hpOpenSession('${sid}')` : `_hpOpenOther('${enc}','${sid}')`;
    return `<div class="hd-r hpn-row" data-sid="${sid}" onclick="event.stopPropagation();${click}" title="${escHtml(x.title)}">${lead}<span class="t">${escHtml(x.title)}</span>${tail}</div>`;
  };
  const sleeping = v.live ? (allSessions.length - _hpActiveCount()) : 0;
  let needs, run;
  if (v.needItems.length) needs = `<div class="hpn-list" ${v.live ? 'id="hp-needs-list"' : ''}>${v.needItems.map(x => row(x, 'need')).join('')}</div>`;
  else if (v.live && v.polled && allSessions.length && !v.runItems.length) needs = `<div class="hpn-empty" id="hp-attention-empty">Nothing needs you. ${sleeping} sleeping.</div>`;
  else needs = `<div class="hd-none">${!v.live && v.needs > 0 ? 'Open the project to see them.' : 'Nothing waiting.'}</div>`;
  // Another project's running sessions are listed only by a web server that
  // knows ?detail=1; an older one gives the count alone.
  run = v.runItems.length ? `<div class="hpn-list" ${v.live ? 'id="hp-running-list"' : ''}>${v.runItems.map(x => row(x, 'run')).join('')}</div>`
    : `<div class="hd-none">${!v.live && v.working > 0 ? 'Open the project to see them.' : 'Nothing running.'}</div>`;
  const week = Array.isArray(v.daily) ? v.daily.reduce((a, b) => a + b, 0) : '–';
  const an = _hpAnimate ? ' hd-anim' : '';
  return `<div class="hd-hero${an}">${_hpMono(name, 40)}<div class="hd-ht"><h2 class="hd-name">${escHtml(name)}</h2>`
    + `<div class="hd-sub">${v.last ? 'Last active ' + _hpAgo(v.last) : (p ? (p.session_count || 0) + ' sessions' : '')}</div></div>`
    + `<button type="button" class="hd-open" id="hd-open" onclick="_hpOpenProject('${enc}')">Open <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg></button></div>`
    + `<div class="hd-stats${an}"><div class="hd-stat${v.needs ? ' n' : ''}"><div class="sm">Needs you</div><b>${v.needs}</b></div>`
    + `<div class="hd-stat w"><div class="sm">Working</div><b>${v.working}</b></div>`
    + `<div class="hd-stat"><div class="sm">Active this week</div><b>${week}</b>${_hpSpark(v.daily)}</div></div>`
    + `<div class="hd-lists${an}" id="hp-attention"><div><div class="sm">Needs you</div>${needs}</div><div><div class="sm">Working</div>${run}</div></div>`;
}

/** Choose a project for the preview (the open project is not changed). */
function _hpChoose(enc) {
  if (!enc || enc === (_hpSel || _hpActiveEnc())) return;
  _hpSel = enc;
  _hpAnimate = true;
  const el = document.getElementById('homepage-container');
  if (el) el.innerHTML = _buildHomepageContent();
  _hpAnimate = false;
  // On a phone the chosen project is drawn at the top: bring it into view.
  const pane = document.getElementById('hd-pane');
  if (pane && window.matchMedia('(max-width: 768px)').matches) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const d = _hpDetail[enc];
  if (enc !== _hpActiveEnc() && (!d || !d.items)) {
    // Its own session list answers at once; the live counts follow.
    _hpDetailFromSessions(enc).then(() => _updateHomepageStats());
    _hpLoadDetail(true);
  }
}
/** Open: the project's sessions (switching project when it is another one). */
function _hpOpenProject(enc) {
  if (!enc || enc === _hpActiveEnc()) { if (typeof setViewMode === 'function') setViewMode('sessions'); return; }
  _hpSel = null;
  if (typeof selectProjectFromOverlay === 'function') selectProjectFromOverlay(enc);
}
/** A session of another project: switch to it, then open the session. */
async function _hpOpenOther(enc, sid) {
  _hpSel = null;
  if (typeof selectProjectFromOverlay === 'function') await selectProjectFromOverlay(enc);
  if (typeof openInGUI === 'function') openInGUI(sid);
}
function _hpAddProject() {
  if (typeof openProjectOverlay === 'function') openProjectOverlay();
  if (typeof addProjectOverlay === 'function') addProjectOverlay();
}

/** Working for N min (the open project), else the last activity time. */
function _hpSince(s) {
  const since = (window._workingSinceMap || {})[s.id];
  if (since) {
    const m = Math.max(0, Math.round((Date.now() - since) / 60000));
    return m < 60 ? m + ' min' : Math.round(m / 60) + ' h';
  }
  return typeof _shortDate === 'function' ? _shortDate(s.last_activity) : '';
}
function _hpActiveCount() {
  return allSessions.filter(s => runningIds.has(s.id)).length;
}

/** Usage meters under the projects: one per usage window the account has
 *  (Week, Fable, 5-hour), from _usageRows (invoke-workforce.js); the full
 *  readings and disk use are in its hover.  Empty until a reading exists;
 *  _renderUsageLimits repaints the Home screen when one arrives. */
const _HP_USAGE_LABEL = { '7d': 'Week', 'Fable': 'Fable', '5h': '5-hour' };
function _hpUsageHtml() {
  if (typeof _usageRows !== 'function') return '';
  const rows = _usageRows().filter(r => r.known && !r.off);
  if (!rows.length) return '';
  const parts = (typeof _usageLimitsParts === 'function') ? _usageLimitsParts() : null;
  const label = r => _HP_USAGE_LABEL[(_USAGE_WINDOW_ORDER.find(w => w.name === r.name) || {}).label] || r.name;
  return `<div class="hs-usage" id="hs-usage" title="${escHtml(parts ? parts.title : '')}">`
    + rows.map(r => {
      const pct = Math.max(0, Math.min(100, r.pct || 0));
      return `<div class="hs-um${r.cls || ''}"><span>${escHtml(label(r))}</span><b><i style="width:${pct}%"></i></b><em>${pct}%</em></div>`;
    }).join('') + '</div>';
}

/** The DevelopNode banner at the top of Home: the mark and name, a greeting,
 *  and how many sessions need you or are working across every project (the
 *  same counts as the project list, _hpCounts). */
const _HP_MARK = '<svg class="hb-mark" viewBox="0 0 181 142" aria-hidden="true"><path d="M0 0h36.5l70 71-70 71H0l70-71z"/><circle cx="154.5" cy="116" r="26"/></svg>';
function _hpBannerHtml() {
  const c = _hpCounts();
  let needs = 0, working = 0;
  for (const k in c) { needs += c[k].needs || 0; working += c[k].working || 0; }
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const n = _hpProjects().length;
  const line = (needs ? `<span class="hb-n">${needs} need you</span>` : 'Nothing needs you')
    + ' · ' + (working ? `<span class="hb-w">${working} working</span>` : 'nothing running')
    + ` · ${n} project${n === 1 ? '' : 's'}`;
  return _HP_MARK.replace('hb-mark', 'hb-mark hb-big')
    + `<div class="hb-lock">${_HP_MARK}<span>DEVELOPNODE<sup>TM</sup></span></div>`
    + `<h2 class="hb-greet">${greet}</h2><div class="hb-line">${line}</div>`;
}

function _buildHomepageContent() {
  // The chosen project must still exist (removed, or the list not loaded yet).
  if (_hpSel && !_hpProjects().some(p => p.encoded === _hpSel)) _hpSel = null;
  _hpLoadDetail(false);
  return `
  <div class="homepage hs hd">
    <div class="hd-wrap">
      <div class="hd-banner" id="hd-banner">${_hpBannerHtml()}</div>
      <div class="hd-grid">
        <div class="hd-side" id="hd-side">${_hpSideHtml()}</div>
        <div class="hd-pane" id="hd-pane">${_hpPaneHtml()}</div>
      </div>
      <div id="hs-usage-wrap">${_hpUsageHtml()}</div>
      <div id="hs-strip-wrap">${_hpStatusStrip()}</div>
    </div>
  </div>`;
}

/** Homepage "Recent" row: switch to the Sessions view and open that session. */
function _hpOpenSession(id) {
  if (typeof setViewMode === 'function') setViewMode('sessions');
  setTimeout(() => { if (typeof openInGUI === 'function') openInGUI(id); }, 300);
}

/** The homepage's two lists, from SessionStore and the live state maps (no
 *  fetch of its own; it re-renders on the same events as the counts).
 *  needs:   waiting on a question or permission (newest first), then finished
 *           sessions with unread output; at most 5 in all.
 *  running: working sessions, most recently started first; at most 5. */
const _HP_LIST_MAX = 5;
function _hpAttentionLists(polled) {
  if (!polled) return { needs: [], running: [] };
  const key = s => s.effective_ts || s.last_activity_ts || s.sort_ts || 0;
  const status = id => (typeof getSessionStatus === 'function') ? getSessionStatus(id) : 'sleeping';
  const unread = id => (typeof hasUnread === 'function') && hasUnread(id);
  const questions = [], finished = [], running = [];
  for (const s of allSessions) {
    const st = status(s.id);
    if (window.SessionVerb) {
      // Person-oriented (session-verb.js): Decide / Unblock / Approve lead,
      // then Review / Read / Send; Working is "Running".
      const r = window.SessionVerb.rank(s.id, st);
      if (r === 0) questions.push(s);
      else if (r === 1) finished.push(s);
      else if (st === 'working') running.push(s);
      continue;
    }
    if (st === 'question') questions.push(s);
    else if (st === 'working') running.push(s);
    else if (unread(s.id)) finished.push(s);
  }
  questions.sort((a, b) => key(b) - key(a));
  finished.sort((a, b) => key(b) - key(a));
  const since = window._workingSinceMap || {};
  running.sort((a, b) => ((since[b.id] || 0) - (since[a.id] || 0)) || (key(b) - key(a)));
  const needs = questions.map(s => ({ s, why: 'question' }))
    .concat(finished.map(s => ({ s, why: 'unread' }))).slice(0, _HP_LIST_MAX);
  return { needs, running: running.slice(0, _HP_LIST_MAX) };
}

/** The strip under the project name: Durable Jobs that
 *  need a person, an older-code Session Engine, and "Name N untitled
 *  sessions".  Every piece reads data another module already keeps:
 *  _usageLimitsPillHtml (invoke-workforce.js, repainted by
 *  _renderUsageLimits), VNJobs.needsPersonCount (jobs.js),
 *  EngineFreshness.last (engine-freshness.js) and window._untitledInfo
 *  (app.js _refreshUntitledButton).  A piece with nothing to say is left out. */
function _hpStatusStrip() {
  const parts = [];
  // Usage is not here: it is the labelled bars top right (_hpUsageHtml).
  const jobs = (window.VNJobs && typeof VNJobs.needsPersonCount === 'function') ? VNJobs.needsPersonCount() : 0;
  if (jobs > 0) {
    parts.push('<button type="button" class="hps-item hps-jobs" id="hp-jobs-link" '
      + 'onclick="event.stopPropagation();if(typeof openDurableJobs===\'function\')openDurableJobs()">'
      + jobs + ' durable job' + (jobs === 1 ? ' needs' : 's need') + ' you</button>');
  }
  // No "Session Engine running older code" line: the engine restarts itself
  // once idle, so there is nothing for the user to do.
  const ut = window._untitledInfo;
  if (ut && ut.project === (localStorage.getItem('activeProject') || '')
      && ut.untitled >= _NAME_UNTITLED_MIN && ut.nameable > 0) {
    parts.push('<button type="button" class="hps-item hps-name" id="hp-name-untitled" '
      + 'onclick="event.stopPropagation();nameUntitledSessions()">Name ' + ut.nameable
      + ' untitled session' + (ut.nameable === 1 ? '' : 's') + '</button>');
  }
  return parts.length ? '<div class="hp-strip" id="hp-strip">' + parts.join('') + '</div>' : '';
}

function _updateHomepageStats() {
  const el = document.getElementById('homepage-container');
  if (!el || el.style.display === 'none') return;
  // Repaint the parts that change, so the page does not flash or replay its animation.
  if (el.querySelector('#hd-pane')) {
    _hpAnimate = false;
    if (_hpSel && !_hpProjects().some(p => p.encoded === _hpSel)) _hpSel = null;
    const set = (id, html) => { const n = document.getElementById(id); if (n && n.innerHTML !== html) n.innerHTML = html; };
    set('hd-side', _hpSideHtml());
    set('hd-pane', _hpPaneHtml());
    set('hs-usage-wrap', _hpUsageHtml());
    set('hs-strip-wrap', _hpStatusStrip());
    set('hd-banner', _hpBannerHtml());
    _hpLoadDetail(false);
    return;
  }
  el.innerHTML = _buildHomepageContent();
}

function dashStartSession() {
  const input = document.getElementById('dash-new-input');
  const text = input ? input.value.trim() : '';
  if (!text) { showToast('Type a message first'); return; }
  // TODO: wire to actual session creation
  showToast('Starting session\u2026');
  addNewAgent();
}

function _colorDiffLines(html) {
  return html.split('\n').map(line => {
    if (/^\+[^+]/.test(line)) return '<span style="color:var(--idle-label);opacity:0.8;">' + line + '</span>';
    if (/^-[^-]/.test(line)) return '<span style="color:var(--result-err);opacity:0.8;">' + line + '</span>';
    if (/^@@/.test(line)) return '<span style="color:var(--accent);opacity:0.6;">' + line + '</span>';
    return line;
  }).join('\n');
}

// The bar widths are fixed, not random: opening a session draws the
// placeholder twice (openInGUI, then startLivePanel once the metadata
// arrives), and random widths made the second draw visibly jump.
const _SKEL_W = [0.31, 0.74, 0.12, 0.58, 0.93, 0.27, 0.66, 0.05, 0.81, 0.44, 0.19, 0.52, 0.88, 0.36, 0.71, 0.09, 0.63, 0.25, 0.97, 0.48];
function _chatSkeleton() {
  let _k = 0;
  const _rnd = () => _SKEL_W[(_k++) % _SKEL_W.length];
  let html = '<div class="conversation">';
  const msgs = [
    {role:'user', lines:2},
    {role:'asst', lines:4},
    {role:'user', lines:1},
    {role:'asst', lines:6},
    {role:'user', lines:2},
    {role:'asst', lines:5},
  ];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const d = (i * 0.1).toFixed(2);
    const isUser = m.role === 'user';
    html += `<div class="msg ${isUser ? 'user' : 'assistant'}" style="margin-bottom:20px;">`;
    // Role label skeleton
    html += `<div style="margin-bottom:5px;"><div class="skel-bar" style="width:40px;height:7px;animation-delay:${d}s;border-radius:3px;"></div></div>`;
    // Bubble skeleton — same style for both sides
    const bw = isUser ? (200 + _rnd() * 150) : (300 + _rnd() * 200);
    html += `<div class="msg-body" style="width:${bw}px;max-width:85%;padding:14px 16px;">`;
    for (let l = 0; l < m.lines; l++) {
      const lw = l === m.lines - 1 ? (40 + _rnd() * 35) : (75 + _rnd() * 25);
      html += `<div class="skel-bar" style="width:${lw}%;height:11px;margin-bottom:${l < m.lines - 1 ? 8 : 0}px;border-radius:4px;animation-delay:${(parseFloat(d) + l * 0.04).toFixed(2)}s;"></div>`;
    }
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

// The placeholder inside the live chat's own frame, exactly as
// startLivePanel() draws it. A bare .conversation gets the old message styling
// (boxed replies, no composer), which showed while a session's details loaded.
function _liveSkeletonShell() {
  const skel = _chatSkeleton().replace('<div class="conversation">', '').replace(/<\/div>$/, '');
  return '<div class="live-panel" id="live-panel">' +
    '<div class="conversation live-log" id="live-log">' + skel + '</div>' +
    '<div class="live-output-shelf" id="live-output-shelf"></div>' +
    '<div id="live-queue-area"></div>' +
    '<div class="live-input-bar" id="live-input-bar"></div></div>';
}

async function loadAllMessages(id) {
  const btn = document.getElementById('btn-load-all');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Loading...'; }
  const _proj2 = localStorage.getItem('activeProject') || '';
  const _projQ2 = _proj2 ? '?project=' + encodeURIComponent(_proj2) : '';
  const resp = await fetch('/api/session/' + id + _projQ2);
  const s = await resp.json();
  document.getElementById('main-body').innerHTML =
    '<div class="conversation" id="convo">' + renderMessages(s.messages) + '</div>';
  _addCopyButtonsToConvo();
  setTimeout(() => {
    const convo = document.getElementById('convo');
    if (convo) {
      convo.scrollTop = convo.scrollHeight;
      if (typeof initStickyUserMessages === 'function') initStickyUserMessages(convo);
    }
  }, 50);
}

/** Add smart copy buttons to all assistant messages in the conversation view */
function _addCopyButtonsToConvo() {
  if (typeof addSmartCopyButtons !== 'function') return;
  document.querySelectorAll('#convo .msg.assistant .msg-body').forEach(body => {
    addSmartCopyButtons(body, body.textContent);
  });
}

function _cleanUserContent(text) {
  // Strip all XML-like system tags injected by Claude Code / IDE
  return text
    .replace(/<[a-z_-]+(?:\s[^>]*)?>[\s\S]*?<\/[a-z_-]+>/g, '')  // matched pairs
    .replace(/<[a-z_-]+(?:\s[^>]*)?\/>/g, '')  // self-closing
    .replace(/<[a-z_-]+(?:\s[^>]*)?>[\s\S]*$/g, '')  // unclosed tag to end
    .trim();
}

function _isSystemMessage(text) {
  const t = text.trim();
  return /^<[a-z_-]+[\s>]/.test(t) ||
    /^This (session is being continued|is a continuation)/.test(t) ||
    /^The user (opened|selected|is viewing)/.test(t) ||
    /^\*\*What we were working on/.test(t) ||
    /^\*\*Key context/.test(t) ||
    /^\*\*Most recent exchanges/.test(t);
}

function renderMessages(messages) {
  if (!messages || !messages.length) return '<div class="empty-state" style="padding:40px 0;"><div style="color:var(--text-faint);font-size:13px;">No messages yet</div></div>';
  return messages.filter(m => m.content).map(m => {
    // Tool use: gear icon + tool names
    if (m.type === 'tool') {
      const names = m.content.replace(/[\[\]]/g, '');
      return `<div class="live-entry live-entry-tool">
        <div class="live-tool-line" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="live-tool-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9"/></svg></span>
          <span class="live-tool-name">${escHtml(names)}</span>
          <button class="live-expand-btn">\u25be</button>
        </div>
        <div class="live-tool-detail">${escHtml(m.content)}</div>
      </div>`;
    }
    // Tool result: expandable output
    if (m.type === 'tool_result') {
      const text = m.content;
      const isShort = text.split('\n').length <= 6;
      return `<div class="live-entry live-entry-result">
        <div class="live-result-line live-result-ok" onclick="this.nextElementSibling.classList.toggle('open')" style="cursor:pointer;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="vertical-align:middle;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>${escHtml(text.slice(0, 80))}${text.length > 80 ? '\u2026' : ''}
        </div>
        <div class="live-tool-detail${isShort ? ' open' : ''}">${mdParse(_colorDiffLines(escHtml(text)))}</div>
      </div>`;
    }
    // User message
    if (m.role === 'user') {
      const cleaned = _cleanUserContent(m.content);
      if (!cleaned) return ''; // skip empty after cleaning
      // System-injected messages render as context, not "me"
      if (_isSystemMessage(m.content)) {
        return `<div class="live-entry live-entry-result">
          <div class="live-result-line" style="color:var(--text-faint);cursor:pointer;" onclick="this.nextElementSibling.classList.toggle('open')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:middle;margin-right:4px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>${escHtml(cleaned.slice(0, 100))}${cleaned.length > 100 ? '\u2026' : ''}
          </div>
          <div class="live-tool-detail">${mdParse(escHtml(cleaned))}</div>
        </div>`;
      }
      return `<div class="msg user">
        <div class="msg-role">me</div>
        <div class="msg-body msg-content"><pre style="white-space:pre-wrap;margin:0;">${escHtml(cleaned)}</pre></div>
      </div>`;
    }
    // Assistant message
    return `<div class="msg assistant">
      <div class="msg-role">claude</div>
      <div class="msg-body msg-content">${mdParse(m.content || '')}</div>
    </div>`;
  }).join('');
}

async function startToolbarRename() {
  if (!activeId) return;
  const titleEl = document.getElementById('main-title');
  const current = titleEl.dataset.customTitle || titleEl.textContent;
  const newName = await showPrompt('Rename Session', '<p>Enter a new name for this session.</p>', {
    value: current,
    confirmText: 'Save',
    placeholder: 'Session name',
  });
  if (newName === null) return;
  _userNamedSessions.add(activeId);  // kill auto-naming instantly
  const resp = await fetch('/api/rename/' + activeId, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({title: newName, project: localStorage.getItem('activeProject') || ''})
  });
  const data = await resp.json();
  if (data.ok) {
    _userNamedSessions.add(activeId);  // protect from auto-naming
    if (typeof _rememberSessionTitle === 'function') _rememberSessionTitle(activeId, data.title || newName);
    setToolbarSession(activeId, newName || activeId, !newName, newName);
    const s = allSessions.find(x => x.id === activeId);
    if (s) { s.custom_title = newName; s.display_title = newName || s.display_title; }
    filterSessions();
    showToast('Renamed');
  } else {
    showToast(data.error || 'Rename failed', true);
  }
}

function openRename(id, currentTitle) {
  renameTarget = id;
  const input = document.getElementById('rename-input');
  input.value = currentTitle || '';
  document.getElementById('rename-overlay').classList.add('show');
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closeRename() {
  document.getElementById('rename-overlay').classList.remove('show');
  renameTarget = null;
}

async function submitRename() {
  const title = document.getElementById('rename-input').value.trim();
  if (!title || !renameTarget) return;

  // Save renameTarget before closeRename() nulls it
  const targetId = renameTarget;
  _userNamedSessions.add(targetId);  // kill auto-naming instantly
  const resp = await fetch('/api/rename/' + targetId, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({title, project: localStorage.getItem('activeProject') || ''})
  });
  const data = await resp.json();
  closeRename();

  if (data.ok) {
    _userNamedSessions.add(targetId);  // protect from auto-naming
    if (typeof _rememberSessionTitle === 'function') _rememberSessionTitle(targetId, data.title);
    // Update local list
    const s = allSessions.find(x => x.id === targetId);
    if (s) { s.custom_title = data.title; s.display_title = data.title; }
    filterSessions();
    // Update toolbar title
    const titleEl = document.getElementById('main-title');
    if (titleEl) { titleEl.textContent = data.title; titleEl.classList.remove('untitled'); }
    showToast('Renamed to "' + data.title + '"');
  } else {
    showToast(data.error || 'Rename failed', true);
  }
}

const _autoNamingInFlight = new Set();
// Sessions the user has manually renamed — auto-naming will never touch these.
const _userNamedSessions = new Set();

async function autoName(id, silent, reEvaluate, promptText) {
  // Never auto-name a session the user has explicitly renamed
  if (_userNamedSessions.has(id)) return;
  const btn = silent ? null : document.getElementById('btn-autoname');
  const btnOrigHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Naming\u2026'; }

  // Mark in-flight so the sidebar can show a "Naming\u2026" indicator
  _autoNamingInFlight.add(id);
  _updateNamingIndicator(id);

  let data;
  try {
    const payload = reEvaluate ? { re_evaluate: true } : promptText ? { prompt: promptText } : {};
    payload.project = localStorage.getItem('activeProject') || '';
    // The person's own "Auto-name" may replace a name the namer chose earlier.
    if (!silent) payload.redo = true;
    const headers = { 'Content-Type': 'application/json' };
    const body = JSON.stringify(payload);
    const resp = await fetch('/api/autonname/' + id, { method: 'POST', headers, body });
    data = await resp.json();
  } catch(e) {
    _autoNamingInFlight.delete(id);
    _updateNamingIndicator(id);
    if (btn) { btn.disabled = false; btn.innerHTML = btnOrigHtml; }
    if (!silent) showToast('Auto-name failed: ' + e.message, true);
    return;
  }

  _autoNamingInFlight.delete(id);
  if (btn) { btn.disabled = false; btn.innerHTML = btnOrigHtml; }

  // If the user renamed this session while the request was in-flight, discard the auto-name result
  if (_userNamedSessions.has(id)) return;

  // "ok" with no title: nothing to show yet (being named, or nothing usable).
  if (data.ok && !data.title) { _updateNamingIndicator(id); return; }

  if (data.ok) {
    // If the session ID was remapped while the autoname LLM call was in-flight,
    // also save the name under the new ID so it isn't lost
    const remappedId = (window._idRemaps && window._idRemaps[id]) || null;
    const effectiveId = remappedId || id;

    // Remember it so a row created or reloaded after this reply still gets it
    // (see _knownSessionTitles in app.js).
    if (data.title && typeof _rememberSessionTitle === 'function') _rememberSessionTitle(effectiveId, data.title);
    const s = allSessions.find(x => x.id === effectiveId) || allSessions.find(x => x.id === id);
    if (s) { s.custom_title = data.title; s.display_title = data.title; }
    filterSessions();

    // Persist the name under the remapped ID too
    if (remappedId) {
      fetch('/api/remap-name', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({old_id:id, new_id:remappedId, project: localStorage.getItem('activeProject') || ''})}).catch(()=>{});
    }

    // Update toolbar title if this is the active session
    if (effectiveId === activeId || id === activeId) {
      const titleEl = document.getElementById('main-title');
      if (titleEl) { titleEl.textContent = data.title; titleEl.classList.remove('untitled'); titleEl.dataset.customTitle = data.title; }
      // Also update kanban session title bar if present
      const kbTitle = document.querySelector('.kanban-session-title');
      if (kbTitle) kbTitle.textContent = data.title;
    }
    // Update kanban drill-down session row name and breadcrumb in-place
    const _kbRow = document.querySelector('.kanban-drill-session-row[data-session-id="' + effectiveId + '"] .kanban-drill-session-name')
      || document.querySelector('.kanban-drill-session-row[data-session-id="' + id + '"] .kanban-drill-session-name');
    if (_kbRow) _kbRow.textContent = data.title;
    const _kbCrumb = document.querySelector('#kanban-session-bar .kanban-drill-crumb.current');
    if (_kbCrumb && (effectiveId === activeId || id === activeId)) _kbCrumb.textContent = data.title;
    if (!silent) showToast('Auto-named: "' + data.title + '"');
  } else {
    _updateNamingIndicator(id);
    if (!silent) showToast('Auto-name failed: ' + (data.error || 'unknown error'), true);
  }
}

/** Update the "Naming…" indicator on a sidebar row without a full re-render. */
function _updateNamingIndicator(id) {
  const row = document.querySelector('.session-item[data-sid="' + id + '"]');
  if (!row) return;
  const nameCell = row.querySelector('.session-col-name');
  if (!nameCell) return;
  const existing = nameCell.querySelector('.naming-badge');
  if (_autoNamingInFlight.has(id)) {
    if (!existing) {
      const badge = document.createElement('span');
      badge.className = 'naming-badge';
      badge.innerHTML = '<span class="naming-dot"></span>Naming\u2026';
      nameCell.appendChild(badge);
    }
  } else if (existing) {
    existing.remove();
  }
}

async function deleteSession(id, opts = {}) {
  const s = allSessions.find(x => x.id === id);
  const name = (s && s.display_title) || id.slice(0, 8);
  // opts.confirmed: the caller already asked (the summary's own Delete ·
  // Cancel, last-card.js _askDelete), so no second popup.
  const confirmed = opts.confirmed ? true : await showConfirm('Delete Session', '<p>Delete <strong>' + escHtml(name) + '</strong>?</p><p>This cannot be undone.</p>', { danger: true, confirmText: 'Delete', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' });
  if (!confirmed) return;

  // Close the session if it's still running
  if (runningIds.has(id)) {
    showToast('Stopping session\u2026');
    // Deleting is an explicit stop \u2014 block ghost recovery from restarting a
    // session we are about to delete. See markUserStopped() in live-panel.js.
    if (typeof markUserStopped === 'function') markUserStopped(id);
    socket.emit('close_session', {session_id: id});
    guiOpenDelete(id);
    runningIds.delete(id);
  }

  showToast('Deleting session\u2026');
  let deleteOk = false;
  try {
    const _dp = localStorage.getItem('activeProject') || '';
    const _dpQ = _dp ? '?project=' + encodeURIComponent(_dp) : '';
    const resp = await fetch('/api/delete/' + id + _dpQ, { method: 'DELETE' });
    // Server may return HTML 500 if unlink failed — guard the JSON parse
    try {
      const data = await resp.json();
      deleteOk = !!(data.ok) || resp.status === 404;
    } catch (_jsonErr) {
      // Non-JSON response (e.g. 500 HTML) — the server-side tombstone is
      // already set so the session won't reappear on reload.  Treat as ok
      // so the card is cleaned up immediately.
      deleteOk = true;
    }
  } catch (_fetchErr) {
    // Network error — still clean up the local card; a refresh will
    // reconcile with the server.
    deleteOk = true;
  }

  if (deleteOk) {
    SessionStore.remove(id);
    // Drop from sidebar multi-selection so the badge count stays honest
    // when a session is deleted via single-target Delete while it was
    // also part of a Ctrl+click selection.
    if (typeof multiSelectedIds !== 'undefined' && multiSelectedIds.has(id)) {
      multiSelectedIds.delete(id);
      if (typeof _renderMultiSelectionBadge === 'function') _renderMultiSelectionBadge();
    }
    // Clean up draft text for deleted session
    if (typeof _clearDraft === 'function') _clearDraft(id);
    // Remove from folder tree
    if (typeof removeSessionFromAllFolders === 'function') removeSessionFromAllFolders(id);
    // Unlink from any kanban tasks (best-effort, don't block)
    fetch('/api/kanban/sessions/' + id + '/unlink-all', { method: 'DELETE' }).catch(() => {});
    if (liveSessionId === id) stopLivePanel();
    // In kanban mode, navigate back to the task (or board) instead of
    // just deselecting — otherwise the user is stuck on a dead view.
    if (typeof viewMode !== 'undefined' && viewMode === 'kanban' && window._kanbanSessionTaskId) {
      _kanbanSessionClose(window._kanbanSessionTaskId);
    } else {
      deselectSession();
    }
    document.getElementById('search').placeholder = 'Search ' + allSessions.length + ' sessions\u2026';
    if (typeof loadProjects === 'function') loadProjects();  // refresh splash-screen session counts
    showToast('Session deleted');
  } else {
    showToast('Delete failed', true);
  }
}

async function deleteEmptySessions() {
  const empty = allSessions.filter(s => s.message_count === 0);
  if (!empty.length) { showToast('No empty sessions found'); return; }
  const confirmed = await showConfirm('Delete Empty Sessions', `<p>Delete <strong>${empty.length}</strong> empty session${empty.length > 1 ? 's' : ''}?</p>`, { danger: true, confirmText: 'Delete All', icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' });
  if (!confirmed) return;

  const _dep = localStorage.getItem('activeProject') || '';
  const _depQ = _dep ? '?project=' + encodeURIComponent(_dep) : '';
  const resp = await fetch('/api/delete-empty' + _depQ, { method: 'DELETE' });
  const data = await resp.json();

  if (data.ok) {
    SessionStore.replaceAll(allSessions.filter(s => s.message_count > 0));
    _rebuildSessionIds();   // multi-selection prune
    if (empty.find(s => s.id === activeId)) {
      if (workspaceActive) {
        _wsExpandedId = null;
        if (liveSessionId) stopLivePanel();
        activeId = null;
        document.getElementById('main-toolbar').style.display = 'none';
      } else {
        activeId = null;
        setToolbarSession(null, 'No session selected', true, '');
        document.getElementById('main-body').innerHTML =
          '<div class="empty-state"><div class="icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></div><div>Sessions deleted</div></div>';
      }
    }
    filterSessions();
    const sessionCountEl = document.getElementById('session-count');
    if (sessionCountEl) sessionCountEl.textContent = allSessions.length + ' sessions';
    if (typeof loadProjects === 'function') loadProjects();  // refresh splash-screen session counts
    showToast(`Deleted ${data.deleted} empty session${data.deleted !== 1 ? 's' : ''}`);
  } else {
    showToast('Delete failed', true);
  }
}

async function duplicateSession(id) {
  const _dupp = localStorage.getItem('activeProject') || '';
  const _duppQ = _dupp ? '?project=' + encodeURIComponent(_dupp) : '';
  const resp = await fetch('/api/duplicate/' + id + _duppQ, { method: 'POST' });
  const data = await resp.json();
  if (data.ok) {
    await loadSessions();
    showToast('Session duplicated');
  } else {
    showToast('Duplicate failed: ' + (data.error || 'unknown'), true);
  }
}

async function continueSession(id) {
  const btn = document.getElementById('btn-continue');
  const btnOrigHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Building\u2026'; }

  const _contp = localStorage.getItem('activeProject') || '';
  const _contpQ = _contp ? '?project=' + encodeURIComponent(_contp) : '';
  const resp = await fetch('/api/continue/' + id + _contpQ, { method: 'POST' });
  const data = await resp.json();

  if (btn) { btn.disabled = false; btn.innerHTML = btnOrigHtml; }

  if (data.ok) {
    await loadSessions();
    // Select and open the new session
    await selectSession(data.new_id);
    showToast('New continuation session created \u2014 open it in Claude to continue');
  } else {
    showToast('Failed: ' + (data.error || 'unknown'), true);
  }
}

async function openInClaude(id) {
  const _openp = localStorage.getItem('activeProject') || '';
  const _openpQ = _openp ? '?project=' + encodeURIComponent(_openp) : '';
  const resp = await fetch('/api/open/' + id + _openpQ, { method: 'POST' });
  const data = await resp.json();
  if (data.ok) showToast('Opening session in Claude\u2026');
  else showToast('Failed to open: ' + (data.error || 'unknown'), true);
}

/* ---- Fork / Rewind / Fork+Rewind message picker ---- */

let _pickerSelectedLine = null;
let _pickerMode = null;
let _pickerSessionId = null;

async function showMessagePicker(sessionId, mode) {
  _pickerMode = mode;
  _pickerSessionId = sessionId;
  _pickerSelectedLine = null;

  const titles = {
    'fork': 'Fork Conversation',
    'rewind': 'Rewind Code',
    'fork-rewind': 'Fork + Rewind Code',
  };
  const descs = {
    'fork': 'Create a new session forked from the selected message. All messages after it will be excluded.',
    'rewind': 'Restore source files to the state they were in at the selected message.',
    'fork-rewind': 'Fork the conversation AND restore source files to the selected message.',
  };

  const overlay = document.getElementById('pm-overlay');
  overlay.innerHTML = `
    <div class="pm-card pm-enter" style="width:680px;max-width:94vw;max-height:85vh;display:flex;flex-direction:column;">
      <h2 class="pm-title">${escHtml(titles[mode] || 'Select Message')}</h2>
      <div class="pm-body" style="margin-bottom:12px;flex-shrink:0;">
        <p>${descs[mode] || ''}</p>
      </div>
      <div class="msg-timeline" id="msg-timeline" style="flex:1;overflow-y:auto;min-height:100px;">
        <div style="padding:24px;text-align:center;color:var(--text-faint);font-size:13px;">
          <span class="spinner"></span> Loading messages\u2026
        </div>
      </div>
      <div class="pm-actions" style="flex-shrink:0;padding-top:12px;">
        <button class="pm-btn pm-btn-secondary" id="pm-cancel">Cancel</button>
        <button class="pm-btn pm-btn-primary" id="pm-confirm" disabled>${escHtml(titles[mode] || 'Confirm')}</button>
      </div>
    </div>`;
  overlay.classList.add('show');
  requestAnimationFrame(() => overlay.querySelector('.pm-card').classList.remove('pm-enter'));

  document.getElementById('pm-cancel').onclick = () => _closePm();
  overlay.onclick = e => { if (e.target === overlay) _closePm(); };
  document.getElementById('pm-confirm').onclick = () => _confirmPicker();

  // Fetch timeline
  try {
    const _tlp = localStorage.getItem('activeProject') || '';
    const _tlpQ = _tlp ? '?project=' + encodeURIComponent(_tlp) : '';
    const url = '/api/session-timeline/' + sessionId + _tlpQ;
    const resp = await fetch(url);
    if (!resp.ok) {
      let errMsg = 'HTTP ' + resp.status;
      try { const d = await resp.json(); errMsg = d.error || errMsg; } catch(e) {}
      document.getElementById('msg-timeline').innerHTML = '<div style="padding:20px;color:#ff9500;font-size:12px;">' + escHtml(errMsg) + '</div>';
      return;
    }
    const data = await resp.json();
    if (data.error) {
      document.getElementById('msg-timeline').innerHTML = '<div style="padding:20px;color:#ff9500;font-size:12px;">' + escHtml(data.error) + '</div>';
      return;
    }
    _renderTimeline(data.messages, data.has_snapshots, mode);
  } catch (e) {
    document.getElementById('msg-timeline').innerHTML = '<div style="padding:20px;color:#ff9500;font-size:12px;">Failed to load: ' + escHtml(e.message) + '</div>';
  }
}

function _renderTimeline(messages, hasSnapshots, mode) {
  const el = document.getElementById('msg-timeline');
  if (!messages || !messages.length) {
    el.innerHTML = '<div style="padding:20px;color:var(--text-faint);text-align:center;">No messages found in this session.</div>';
    return;
  }

  // For rewind modes, warn if no snapshots
  if ((mode === 'rewind' || mode === 'fork-rewind') && !hasSnapshots) {
    el.innerHTML = '<div style="padding:20px;color:#ff9500;text-align:center;">This session has no file snapshots. Code rewind is not available.</div>';
    return;
  }

  // For fork modes, only show user messages (forking from Claude output doesn't make sense)
  const forkOnly = (mode === 'fork' || mode === 'fork-rewind');
  const filtered = forkOnly ? messages.filter(m => m.role === 'user') : messages;

  if (!filtered.length) {
    el.innerHTML = '<div style="padding:20px;color:var(--text-faint);text-align:center;">No user messages found in this session.</div>';
    return;
  }

  let html = '';
  for (const m of filtered) {
    const roleClass = m.role === 'user' ? 'user' : 'assistant';
    const roleLabel = m.role === 'user' ? 'me' : 'claude';

    // Format timestamp
    let tsDisplay = '';
    if (m.ts) {
      try {
        const d = new Date(m.ts);
        tsDisplay = d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
      } catch(e) { tsDisplay = ''; }
    }

    // Change counts
    let changesHtml = '';
    if (m.changes && (m.changes.added || m.changes.removed)) {
      const parts = [];
      if (m.changes.added) parts.push('<span class="tl-add">+' + m.changes.added + '</span>');
      if (m.changes.removed) parts.push('<span class="tl-rem">-' + m.changes.removed + '</span>');
      changesHtml = parts.join(' ');
    }

    // File badges
    let filesHtml = '';
    if (m.changes && m.changes.files && m.changes.files.length) {
      filesHtml = '<span class="tl-files">' + m.changes.files.map(f => escHtml(f)).join(', ') + '</span>';
    }

    // Snapshot indicator
    const snapIcon = m.has_snapshot ? '<span class="tl-snap" title="File snapshot available">&#128190;</span>' : '';

    html += '<div class="tl-row" data-line="' + m.line_number + '" onclick="_selectTimelineRow(this)">'
      + '<span class="tl-idx">#' + (m.index + 1) + '</span>'
      + '<span class="tl-role ' + roleClass + '">' + roleLabel + '</span>'
      + '<span class="tl-preview">' + escHtml(m.preview) + '</span>'
      + (filesHtml ? '<span class="tl-file-wrap">' + filesHtml + '</span>' : '')
      + (changesHtml ? '<span class="tl-changes">' + changesHtml + '</span>' : '')
      + snapIcon
      + '<span class="tl-ts">' + escHtml(tsDisplay) + '</span>'
      + '</div>';
  }
  el.innerHTML = html;
}

function _selectTimelineRow(rowEl) {
  // Deselect previous
  const prev = document.querySelector('.tl-row.selected');
  if (prev) prev.classList.remove('selected');
  rowEl.classList.add('selected');
  _pickerSelectedLine = parseInt(rowEl.dataset.line, 10);
  const btn = document.getElementById('pm-confirm');
  if (btn) btn.disabled = false;
}

async function _confirmPicker() {
  if (!_pickerSelectedLine || !_pickerSessionId || !_pickerMode) return;

  const btn = document.getElementById('pm-confirm');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Working\u2026'; }

  const body = JSON.stringify({ up_to_line: _pickerSelectedLine });
  const hdrs = { 'Content-Type': 'application/json' };

  try {
    let endpoint = '';
    if (_pickerMode === 'fork') endpoint = '/api/fork/';
    else if (_pickerMode === 'rewind') endpoint = '/api/rewind/';
    else endpoint = '/api/fork-rewind/';

    const _frkp = localStorage.getItem('activeProject') || '';
    const _frkpQ = _frkp ? '?project=' + encodeURIComponent(_frkp) : '';
    const resp = await fetch(endpoint + _pickerSessionId + _frkpQ, { method: 'POST', headers: hdrs, body });
    if (!resp.ok) {
      let errMsg = 'HTTP ' + resp.status;
      try { const d = await resp.json(); errMsg = d.error || errMsg; } catch(e) {}
      _closePm();
      showToast(errMsg, true);
      return;
    }
    const data = await resp.json();
    _closePm();

    if (data.error) {
      showToast(data.error, true);
      return;
    }

    if (_pickerMode === 'fork' || _pickerMode === 'fork-rewind') {
      await loadSessions();
      if (data.new_id) await openInGUI(data.new_id);

      let msg = 'Session forked';
      if (data.files_restored && data.files_restored.length) {
        msg += ' and ' + data.files_restored.length + ' file(s) restored';
      }
      showToast(msg);
    } else {
      // rewind only
      let msg = '';
      if (data.files_restored && data.files_restored.length) {
        msg = data.files_restored.length + ' file(s) restored to earlier state';
      } else {
        msg = 'Rewind complete (no files to restore)';
      }
      if (data.files_skipped && data.files_skipped.length) {
        msg += ' (' + data.files_skipped.length + ' skipped)';
      }
      showToast(msg);
      // Surface the rewind-orphan modal (sessions.js)
      // when the backend flagged children whose anchor was rewound past.
      if (data.rewind_orphans && data.rewind_orphans.length
        && typeof window._handleRewindOrphans === 'function') {
        window._handleRewindOrphans(_pickerSessionId, data.rewind_orphans);
      }
    }
  } catch (e) {
    _closePm();
    showToast('Operation failed: ' + e.message, true);
  }
}

/* ---- Sidebar resize / hide (desktop) ----
   The divider is the one control for the panel's width, including hiding it:
   drag to resize; drag past the minimum to hide (it snaps shut); drag back out,
   click the slim edge strip, or double-click the divider to bring it back.
   This replaced the collapse arrow on desktop.  Phones keep their arrow as the
   drawer's close button (mobile.css), and their drawer never uses this. */
(function() {
  const handle = document.getElementById('resize-handle');
  const sidebar = document.querySelector('.sidebar');
  const HIDE_BELOW = 110, SHOW_ABOVE = 140, MIN_W = 180, MAX_W = 600;
  // The open width is remembered per device.  Dragging the panel shut passes
  // through the 180px minimum on its way, so the width it had when the drag
  // started is put back as it hides: otherwise it reopened at 180px.
  const WIDTH_KEY = 'sidebarWidthDesktop';
  const setWidth = w => document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  const savedW = parseInt(localStorage.getItem(WIDTH_KEY), 10);
  if (savedW >= MIN_W && savedW <= MAX_W) setWidth(savedW);
  let dragging = false, moved = false, startX = 0, startW = 0, startCollapsed = false;
  const isCollapsed = () => sidebar.classList.contains('collapsed');
  const syncTitle = () => {
    handle.title = isCollapsed()
      ? 'Show sessions panel (click or drag right)'
      : 'Drag to resize \u00b7 double-click to hide';
  };
  const setCollapsed = want => {
    if (isCollapsed() !== want && typeof toggleSidebar === 'function') toggleSidebar();
    syncTitle();
  };
  syncTitle();
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.tabIndex = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true; moved = false;
    startX = e.clientX;
    startCollapsed = isCollapsed();
    startW = startCollapsed ? 0 : sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const raw = startW + e.clientX - startX;
    if (Math.abs(e.clientX - startX) > 3) moved = true;
    if (!isCollapsed() && raw < HIDE_BELOW) {
      const keep = startCollapsed ? parseInt(localStorage.getItem(WIDTH_KEY), 10) : startW;
      if (keep >= MIN_W && keep <= MAX_W) setWidth(keep);
      setCollapsed(true); return;
    }
    if (isCollapsed()) { if (raw < SHOW_ABOVE) return; setCollapsed(false); }
    setWidth(Math.min(MAX_W, Math.max(MIN_W, raw)));
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // A plain click on the strip of a hidden panel opens it.
    if (!moved && startCollapsed) setCollapsed(false);
    else syncTitle();
    if (moved && !isCollapsed()) localStorage.setItem(WIDTH_KEY, String(sidebar.offsetWidth));
  });

  handle.addEventListener('dblclick', () => setCollapsed(!isCollapsed()));
  handle.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(!isCollapsed()); }
  });
})();
