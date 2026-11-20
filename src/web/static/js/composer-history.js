/* Composer history: Up / Down in the message box step through what was sent
 * before, the way a terminal's command line does.
 *
 * Scope:
 *   - an existing session: the messages sent in THAT session (what this tab
 *     recorded, plus the person's bubbles in the thread, so messages sent from
 *     another device or before this file existed are there too);
 *   - the new-session box: the first prompts of earlier new sessions. A first
 *     prompt is recorded in BOTH lists: the new-session list and the session it
 *     starts, so Up in that session finds it too.
 *
 * Up only acts with the caret on the first line and Down on the last, so moving
 * through a multi-line message still works. Leaving the end of the list puts
 * back what was being typed. Typing ends the walk: the edited text is the draft.
 *
 * Recording wraps the submit functions (they read the box, then clear it), so
 * this file must load after app.js and live-panel.js. Stored per device in
 * localStorage (vnComposerHistory), at most MAX entries per list.
 */
(function () {
  'use strict';
  // A demo page on the same site sets its own key, so it never touches the real lists.
  const KEY = window.VN_COMPOSER_HISTORY_KEY || 'vnComposerHistory';
  const NEW = '__new__';
  const MAX = 200;
  const BOXES = { 'live-input-ta': 1, 'live-queue-ta': 1 };

  function _load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_e) { return {}; }
  }
  function _save(all) {
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (_e) { /* full or blocked */ }
  }

  function record(scope, text) {
    text = (text || '').trim();
    if (!scope || !text) return;
    const all = _load();
    const list = (all[scope] || []).filter(t => t !== text);
    list.push(text);
    all[scope] = list.slice(-MAX);
    _save(all);
  }

  function rekey(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    const all = _load();
    if (!all[oldId]) return;
    const merged = (all[newId] || []).filter(t => all[oldId].indexOf(t) < 0).concat(all[oldId]);
    all[newId] = merged.slice(-MAX);
    delete all[oldId];
    _save(all);
  }

  function _isNewBox(ta) {
    const h = ta.getAttribute('onkeydown') || '';
    if (h.indexOf('_newSessionSubmit') >= 0) return true;
    return typeof _isUnsentNewSession === 'function' && typeof liveSessionId !== 'undefined' &&
      _isUnsentNewSession(liveSessionId);
  }

  function _threadMessages(sid) {
    const log = document.getElementById('live-log');
    if (!log) return [];
    const out = [];
    log.querySelectorAll('.msg.user').forEach(div => {
      if (div.classList.contains('vn-event-msg')) return;
      if (div.dataset.sid && div.dataset.sid !== sid) return;
      const t = (typeof div._vnFullText === 'string' ? div._vnFullText : '').trim();
      if (t) out.push(t);
    });
    return out;
  }

  /** Oldest first, no repeats in a row. */
  function entries(scope, sid) {
    const stored = _load()[scope] || [];
    let list;
    if (scope === NEW) {
      list = stored.slice();
    } else {
      const seen = new Set(stored);
      list = _threadMessages(sid).filter(t => !seen.has(t)).concat(stored);
    }
    return list.filter((t, i) => i === 0 || t !== list[i - 1]);
  }

  // ── The walk ──
  let walk = null;   // { ta, list, idx, draft }

  function _set(ta, text) {
    ta.value = text;
    if (typeof _autoResizeTextarea === 'function') _autoResizeTextarea(ta);
    const end = text.length;
    try { ta.setSelectionRange(end, end); } catch (_e) { /* detached */ }
    ta.dispatchEvent(new Event('vn-history', { bubbles: true }));
  }

  document.addEventListener('keydown', function (e) {
    const ta = e.target;
    if (!ta || !BOXES[ta.id] || e.defaultPrevented || e.isComposing) return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const v = ta.value, pos = ta.selectionStart;

    if (e.key === 'ArrowUp') {
      if (v.lastIndexOf('\n', pos - 1) >= 0) return;          // not on the first line
      if (!walk || walk.ta !== ta) {
        const sid = typeof liveSessionId !== 'undefined' ? liveSessionId : '';
        const scope = _isNewBox(ta) ? NEW : sid;
        const list = entries(scope, sid);
        if (!list.length) return;
        walk = { ta, list, idx: list.length, draft: v };
      }
      if (walk.idx <= 0) { e.preventDefault(); return; }
      e.preventDefault();
      walk.idx -= 1;
      _set(ta, walk.list[walk.idx]);
    } else {
      if (!walk || walk.ta !== ta) return;
      if (v.indexOf('\n', pos) >= 0) return;                  // not on the last line
      e.preventDefault();
      walk.idx += 1;
      if (walk.idx >= walk.list.length) {
        const draft = walk.draft;
        walk = null;
        _set(ta, draft);
      } else {
        _set(ta, walk.list[walk.idx]);
      }
    }
  });

  // Typing (or anything that changes the box except the walk) ends the walk.
  document.addEventListener('input', function (e) {
    if (walk && e.target === walk.ta) walk = null;
  });
  document.addEventListener('focusout', function (e) {
    if (walk && e.target === walk.ta) walk = null;
  });

  // ── Recording: wrap each submit path ──
  function _wrap(name, scopeOf) {
    const orig = window[name];
    if (typeof orig !== 'function' || orig._vnHistory) return;
    const wrapped = function () {
      try {
        const ta = document.getElementById('live-input-ta') || document.getElementById('live-queue-ta');
        const text = ta ? ta.value : '';
        const scopes = scopeOf.apply(null, arguments);
        scopes.forEach(s => record(s, text));
      } catch (_e) { /* recording never blocks a send */ }
      walk = null;
      return orig.apply(this, arguments);
    };
    wrapped._vnHistory = true;
    window[name] = wrapped;
  }
  const _current = () => [typeof liveSessionId !== 'undefined' ? liveSessionId : ''];
  _wrap('_newSessionSubmit', sid => [NEW, sid]);
  _wrap('liveSubmitIdle', _current);
  _wrap('liveSubmitWaiting', _current);
  _wrap('liveQueueSave', _current);
  _wrap('liveSubmitContinue', _current);

  // A new session adopts the CLI's real id after its first message.
  if (typeof socket !== 'undefined' && socket && socket.on) {
    socket.on('session_id_remapped', d => { if (d) rekey(d.old_id, d.new_id); });
  }

  window.VNComposerHistory = { record, entries, rekey, NEW };
})();
