/* quiet-nudge.js — "All your sessions are quiet": a bubble beside the Publish button.
 *
 * While the VibeNode repo is the open project, the moment its sessions go from
 * busy (at least one Working or Needs you) to quiet (none of either) and the repo
 * has changes to publish, a small bubble points at the Update / Publish / Sync
 * button with Publish, a close (not now) and "Don't show this again".
 *
 * - It fires on the crossing only: opening the app while already quiet shows nothing.
 * - Quiet must hold for QUIET_HOLD_MS, so a session that ends one turn and starts
 *   its queued next one does not flash it.
 * - The stop is the `quiet_publish_nudge` preference (System > Preferences), also
 *   kept per device in localStorage so it holds before the web server knows the key.
 * - Counts come from session-verb.js, the same statuses the sidebar draws.
 */
(function () {
  'use strict';
  if (window.VNQuietNudge) return;

  const QUIET_HOLD_MS = 4000;
  const LS_OFF = 'vnQuietNudge';
  const PREF = 'quiet_publish_nudge';

  let _repo = null;          // {project, root} of this app's own repo, once known
  let _repoAsked = false;
  let _baseProject = null;   // the project the baseline below belongs to
  let _wasBusy = null;       // null until a first real reading
  let _holdTimer = null;
  let _el = null;
  let _serverOff = false;
  let _lastEval = 0, _evalTimer = null;

  function enabled() {
    try { if (localStorage.getItem(LS_OFF) === 'off') return false; } catch (e) {}
    return !_serverOff;
  }

  async function _loadRepo() {
    if (_repoAsked) return;
    _repoAsked = true;
    try {
      const r = await fetch('/api/repo-project');
      const d = r.ok ? await r.json() : null;
      if (d && d.ok && d.project) _repo = d;
    } catch (e) {}
    try {
      const r = await fetch('/api/kanban/config');
      const c = r.ok ? await r.json() : null;
      if (c && c[PREF] === false) _serverOff = true;
    } catch (e) {}
  }

  function _onRepoProject() {
    if (!_repo) return false;
    if (window.VNAllProjects && VNAllProjects.on && VNAllProjects.on()) return false;
    let p = '';
    try { p = localStorage.getItem('activeProject') || ''; } catch (e) {}
    return p === _repo.project;
  }

  function _busyCount() {
    const SV = window.SessionVerb, SS = window.SessionStore;
    if (!SV || !SV.shown || !SV.display || !SS) return null;
    if (typeof _waitingPolledOnce !== 'undefined' && !_waitingPolledOnce) return null;
    let n = 0;
    SS.all().forEach(s => {
      const g = SV.shown(SV.display(s.id));
      if (g === 'needs' || g === 'working') n++;
    });
    return n;
  }

  function _hasPush() {
    const g = window._gitStatus || (typeof _gitStatus !== 'undefined' ? _gitStatus : {}) || {};
    return g.ahead > 0 || !!g.uncommitted;
  }
  function _changeCount() {
    const g = (typeof _gitStatus !== 'undefined' ? _gitStatus : {}) || {};
    return g.ahead > 0 ? g.ahead : 0;
  }

  function _button() {
    return ['btn-git-publish', 'btn-git-sync', 'btn-git-update']
      .map(id => document.getElementById(id))
      .find(b => b && b.getClientRects().length && b.offsetWidth) || null;
  }

  function hide() {
    if (!_el) return;
    const el = _el; _el = null;
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  }

  function _place() {
    if (!_el) return;
    const b = _button();
    if (!b) { hide(); return; }
    const r = b.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    const w = _el.offsetWidth, h = _el.offsetHeight;
    // A button in the left rail: the bubble sits to its right.  Anywhere else
    // (the phone's top bar): under it, kept on screen.
    if (r.left < 80 && r.right + 12 + w <= vw) {
      _el.dataset.side = 'right';
      _el.style.left = (r.right + 12) + 'px';
      _el.style.top = Math.max(8, Math.min(vh - h - 8, r.top + r.height / 2 - h / 2)) + 'px';
      _el.style.setProperty('--qn-arrow', (r.top + r.height / 2 - parseFloat(_el.style.top) - 6) + 'px');
    } else {
      _el.dataset.side = 'below';
      const left = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2));
      _el.style.left = left + 'px';
      _el.style.top = (r.bottom + 12) + 'px';
      _el.style.setProperty('--qn-arrow', (r.left + r.width / 2 - left - 6) + 'px');
    }
  }

  function show() {
    if (_el || !enabled() || !_hasPush()) return;
    if (!_button()) return;
    const n = _changeCount();
    const what = n ? n + ' ' + (n === 1 ? 'change' : 'changes') + ' not published yet.' : 'Unsaved edits not published yet.';
    const el = document.createElement('div');
    el.className = 'vn-quiet-nudge';
    el.setAttribute('role', 'status');
    el.innerHTML = '<button type="button" class="qn-x" data-qn="later" title="Not now" aria-label="Not now">×</button>'
      + '<div class="qn-t">All your sessions are quiet</div>'
      + '<div class="qn-b"></div>'
      + '<div class="qn-row"><button type="button" class="qn-go" data-qn="go">Publish</button>'
      + '<button type="button" class="qn-stop" data-qn="stop">Don’t show this again</button></div>';
    el.querySelector('.qn-b').textContent = what;
    el.addEventListener('click', e => {
      const a = e.target.closest('[data-qn]');
      if (!a) return;
      const act = a.dataset.qn;
      hide();
      if (act === 'go') {
        const b = _button();
        if (b) b.click(); else if (typeof openGitPublish === 'function') openGitPublish();
      } else if (act === 'stop') {
        setEnabled(false);
        if (typeof showToast === 'function') showToast('Won’t show that again. Turn it back on in System → Preferences.');
      }
    });
    document.body.appendChild(el);
    _el = el;
    _place();
    requestAnimationFrame(() => requestAnimationFrame(() => { if (_el === el) el.classList.add('in'); }));
  }

  function setEnabled(on) {
    try { if (on) localStorage.removeItem(LS_OFF); else localStorage.setItem(LS_OFF, 'off'); } catch (e) {}
    _serverOff = !on;
    if (!on) hide();
    fetch('/api/kanban/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [PREF]: on }),
    }).catch(() => {});
  }

  function evaluate() {
    if (!_repoAsked) { _loadRepo().then(evaluate); return; }
    const proj = _onRepoProject() ? _repo.project : null;
    if (proj !== _baseProject) {
      // A new project (or leaving the repo's): start a fresh baseline, never fire on arrival.
      _baseProject = proj; _wasBusy = null; clearTimeout(_holdTimer); _holdTimer = null; hide();
    }
    if (!proj) return;
    const n = _busyCount();
    if (n === null) return;
    const busy = n > 0;
    if (busy) {
      clearTimeout(_holdTimer); _holdTimer = null;
      hide();
    } else if (_wasBusy === true && !_holdTimer) {
      _holdTimer = setTimeout(() => {
        _holdTimer = null;
        if (_baseProject && _busyCount() === 0) {
          _wasBusy = false;   // this crossing is used up; the next one needs busy again
          if (typeof pollGitStatus === 'function') pollGitStatus().then(show, show); else show();
        }
      }, QUIET_HOLD_MS);
    }
    if (_el && !_hasPush()) hide();   // published meanwhile
    // Busy-ness only moves the baseline once quiet has held, so a short dip stays a crossing.
    if (busy || !_holdTimer) _wasBusy = busy;
  }

  function schedule() {
    const now = Date.now();
    if (now - _lastEval >= 500) { _lastEval = now; evaluate(); return; }
    if (_evalTimer) return;
    _evalTimer = setTimeout(() => { _evalTimer = null; _lastEval = Date.now(); evaluate(); }, 500);
  }

  function start() {
    if (window.SessionStore && SessionStore.subscribe) SessionStore.subscribe(schedule);
    setInterval(schedule, 3000);
    window.addEventListener('resize', _place);
    schedule();
  }

  window.VNQuietNudge = { enabled, setEnabled, show, hide, evaluate, _state: () => ({ repo: _repo, wasBusy: _wasBusy, base: _baseProject }) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
